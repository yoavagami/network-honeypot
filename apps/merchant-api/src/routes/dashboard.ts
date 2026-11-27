import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { policySchema, DEFAULT_POLICY, type Assessment } from "@honeypot/merchant-contract";
import { withMerchant, type MerchantTx } from "@honeypot/merchant-db";
import type { Deps } from "../context.js";
import {
  atLeast, clearSessionCookies, createSession, csrfOk, loadSession, setSessionCookies, SESSION_COOKIE,
  type MerchantRole, type MerchantSession,
} from "../merchantAuth.js";
import { overview, listVisits, listOrders, getOrder, recentPayEvents, type Scope } from "../queries.js";
import { integrationStatus } from "../status.js";
import { displayKey, generateKey, generateWebhookSecret, hashKey } from "../keys.js";
import { encrypt, sha256, ipHash } from "../crypto.js";
import { randomString, newMerchantId } from "../ids.js";
import { normaliseHost, verifyDomain, VERIFY_PREFIX } from "../domains.js";
import { enqueueEvent } from "../webhooks/enqueue.js";
import { buildVisitDetail } from "../visitDetail.js";
import { RateLimiter } from "../ratelimit.js";

declare module "fastify" {
  interface FastifyRequest { merchantSession?: MerchantSession | null }
}

const loginLimiter = new RateLimiter(10, 15 * 60_000);
const requestAccessLimiter = new RateLimiter(5, 3600_000);
const inviteLimiter = new RateLimiter(20, 15 * 60_000);
/** Same cost whether or not the email exists, so timing doesn't reveal accounts. */
const DUMMY_HASH = argon2.hash("not-a-real-password-" + randomString(16));

const modeOf = (q: unknown): boolean => (q as { mode?: string } | undefined)?.mode === "live";
const audit = (tx: MerchantTx, s: MerchantSession, action: string, detail: object = {}) =>
  tx`INSERT INTO merchant_audit (merchant_id, actor, action, detail) VALUES (${s.merchantId}, ${`user:${s.email}`}, ${action}, ${tx.json(detail as any)})`;

export const PUBLIC_DASHBOARD_PATHS = ["/m/api/auth/login", "/m/api/request-access"];

export function registerDashboard(app: FastifyInstance, deps: Deps) {
  const { config } = deps;

  // CORS for a dashboard served from another origin (local development); production is same-origin.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/m/api/")) return;
    const origin = request.headers.origin;
    if (origin && config.dashboardOrigins.includes(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
      if (request.method === "OPTIONS") {
        reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        reply.header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
        return reply.status(204).send();
      }
    }
    reply.header("Cache-Control", "no-store");
    request.merchantSession = await loadSession(deps.app, request.cookies[SESSION_COOKIE]);
    const path = request.url.split("?")[0]!;
    if (PUBLIC_DASHBOARD_PATHS.includes(path) || path.startsWith("/m/api/invites/")) return;
    if (!request.merchantSession) return reply.status(401).send({ error: { code: "unauthenticated", message: "Sign in required" } });
    if (request.method !== "GET" && !csrfOk(request, request.merchantSession)) return reply.status(403).send({ error: { code: "csrf_failed", message: "CSRF validation failed" } });
  });

  const session = (r: FastifyRequest) => r.merchantSession!;
  const requireRole = (r: FastifyRequest, reply: FastifyReply, min: MerchantRole) => {
    if (atLeast(session(r).role, min)) return true;
    reply.status(403).send({ error: { code: "forbidden", message: `Needs the ${min} role.` } });
    return false;
  };
  const scoped = <T>(r: FastifyRequest, fn: (tx: MerchantTx, scope: Scope) => Promise<T>) =>
    withMerchant(deps.app, session(r).merchantId, (tx) => fn(tx, { merchantId: session(r).merchantId, livemode: modeOf(r.query) }));
  const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: { code: "invalid_request", message } });

  // ---------------------------------------------------------------- auth

  app.post("/m/api/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).safeParse(request.body);
    if (!body.success) return bad(reply, "Email and password are required.");
    const email = body.data.email.toLowerCase();
    if (loginLimiter.hit(`ip:${request.ip}`) < 0 || loginLimiter.hit(`email:${email}`) < 0) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts. Try again in 15 minutes." } });
    }
    const [u] = await deps.app<any[]>`SELECT * FROM mk_login_lookup(${email})`;
    const ok = await argon2.verify(u?.password_hash ?? (await DUMMY_HASH), body.data.password).catch(() => false);
    if (!u || !ok || u.disabled || u.merchant_status !== "approved") return reply.status(401).send({ error: { code: "invalid_credentials", message: "Email or password is wrong." } });
    const { token, csrf } = await createSession(deps.app, u.user_id, u.merchant_id);
    setSessionCookies(reply, config.cookieSecure, token, csrf);
    return reply.send({ ok: true, csrf });
  });

  app.post("/m/api/auth/logout", async (request, reply) => {
    const s = session(request);
    await withMerchant(deps.app, s.merchantId, (tx) => tx`DELETE FROM merchant_user_sessions WHERE session_hash = ${s.sessionHash}`);
    clearSessionCookies(reply, config.cookieSecure);
    return reply.send({ ok: true });
  });

  app.get("/m/api/auth/me", async (request, reply) => {
    const s = session(request);
    const keys = await withMerchant(deps.app, s.merchantId, (tx) => tx`SELECT livemode FROM api_keys WHERE merchant_id = ${s.merchantId} AND revoked_at IS NULL GROUP BY livemode`);
    return reply.send({
      user: { email: s.email, name: s.name, role: s.role },
      merchant: { id: s.merchantId, company: s.company },
      csrf: s.csrfToken,
      live_available: keys.some((k) => k.livemode),
    });
  });

  // ---------------------------------------------------------------- public: request access, invites

  app.post("/m/api/request-access", async (request, reply) => {
    const body = z.object({
      company: z.string().trim().min(1).max(200),
      website: z.string().trim().min(3).max(255),
      email: z.string().trim().email().max(254),
      platform: z.enum(["custom", "shopify", "woocommerce", "other"]).default("custom"),
      monthly_checkouts: z.string().max(40).optional(),
    }).safeParse(request.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? "Please fill in every field.");
    if (requestAccessLimiter.hit(request.ip) < 0) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests from this network. Try again later." } });
    const d = body.data;
    await deps.app`SELECT mk_request_access(${newMerchantId()}, ${d.company}, ${d.website}, ${d.email}, ${d.platform}, ${d.monthly_checkouts ?? null}, ${ipHash(config.ipHashSecret, "request", request.ip)})`;
    return reply.status(202).send({ received: true });
  });

  app.get<{ Params: { token: string } }>("/m/api/invites/:token", async (request, reply) => {
    if (inviteLimiter.hit(request.ip) < 0) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts." } });
    const [i] = await deps.app<any[]>`SELECT * FROM mk_invite_lookup(${sha256(request.params.token)})`;
    const valid = Boolean(i && !i.used && new Date(i.expires_at).getTime() > Date.now() && i.merchant_status === "approved");
    if (!valid) return reply.status(404).send({ error: { code: "invite_invalid", message: "This invite link is invalid, used or expired. Ask for a new one." } });
    return reply.send({ company: i.company, email: i.email, role: i.role, expires_at: i.expires_at });
  });

  app.post<{ Params: { token: string } }>("/m/api/invites/:token/accept", async (request, reply) => {
    if (inviteLimiter.hit(request.ip) < 0) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts." } });
    const body = z.object({ name: z.string().trim().min(1).max(120), password: z.string().min(12).max(256), accept_terms: z.literal(true) }).safeParse(request.body);
    if (!body.success) return bad(reply, "Enter your name, a password of at least 12 characters, and accept the terms.");
    const tokenHash = sha256(request.params.token);
    const [i] = await deps.app<any[]>`SELECT * FROM mk_invite_lookup(${tokenHash})`;
    if (!i || i.used || new Date(i.expires_at).getTime() < Date.now() || i.merchant_status !== "approved") {
      return reply.status(404).send({ error: { code: "invite_invalid", message: "This invite link is invalid, used or expired." } });
    }
    const [taken] = await deps.app`SELECT mk_email_taken(${i.email}) AS taken`;
    if (taken?.taken) return reply.status(409).send({ error: { code: "email_taken", message: "This email already has a uHoney login. Sign in instead." } });
    const hash = await argon2.hash(body.data.password, { type: argon2.argon2id });
    const userId = await withMerchant(deps.app, i.merchant_id, async (tx) => {
      const used = await tx`UPDATE merchant_invites SET used_at = now() WHERE token_hash = ${tokenHash} AND used_at IS NULL RETURNING 1`;
      if (!used.length) return null;
      const [u] = await tx`INSERT INTO merchant_users (merchant_id, email, name, password_hash, role) VALUES (${i.merchant_id}, ${i.email}, ${body.data.name}, ${hash}, ${i.role}) RETURNING user_id`;
      await tx`INSERT INTO merchant_audit (merchant_id, actor, action, detail) VALUES (${i.merchant_id}, ${`user:${i.email}`}, 'invite.accepted', ${tx.json({ role: i.role, terms_accepted_at: new Date().toISOString() } as any)})`;
      return u!.user_id as string;
    });
    if (!userId) return reply.status(404).send({ error: { code: "invite_invalid", message: "This invite link was already used." } });
    const { token, csrf } = await createSession(deps.app, userId, i.merchant_id);
    setSessionCookies(reply, config.cookieSecure, token, csrf);
    return reply.send({ ok: true, csrf });
  });

  // ---------------------------------------------------------------- data

  app.get("/m/api/overview", async (request, reply) => {
    const days = Math.min(Math.max(Number((request.query as any).days) || 7, 1), 90);
    return reply.send(await scoped(request, (tx, s) => overview(tx, s, days)));
  });

  app.get("/m/api/visits", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const visits = await scoped(request, (tx, s) => listVisits(tx, s, { driver: q.driver || undefined, agentsOnly: q.agents === "1", bucket: q.bucket || undefined, before: q.before, limit: Number(q.limit) || 50 }));
    // Lab labels are uHoney's internal testing; merchants don't see them.
    return reply.send({ visits: visits.map(({ lab_label: _l, lab_verified: _v, ...rest }: any) => rest) });
  });

  app.get<{ Params: { id: string } }>("/m/api/visits/:id", async (request, reply) => {
    const out = await scoped(request, (tx, s) => buildVisitDetail(tx, s, request.params.id, "merchant"));
    if (!out) return reply.status(404).send({ error: { code: "not_found", message: "No such visit." } });
    return reply.send(out);
  });

  app.get("/m/api/orders", async (request, reply) => {
    const q = request.query as Record<string, string>;
    return reply.send({ orders: await scoped(request, (tx, s) => listOrders(tx, s, { decision: q.decision || undefined, driver: q.driver || undefined, before: q.before, limit: Number(q.limit) || 50 })) });
  });

  app.get<{ Params: { id: string } }>("/m/api/orders/:id", async (request, reply) => {
    const out = await scoped(request, (tx, s) => getOrder(tx, s, request.params.id));
    if (!out) return reply.status(404).send({ error: { code: "not_found", message: "No such order." } });
    return reply.send(out);
  });

  app.get("/m/api/live", async (request, reply) => {
    return reply.send(await scoped(request, async (tx, s) => ({
      visits: (await listVisits(tx, s, { activeSinceMs: 10 * 60_000, limit: 50 })).map(({ lab_label: _l, lab_verified: _v, ...rest }: any) => rest),
      pay_events: await recentPayEvents(tx, s, 30 * 60_000),
      at: new Date().toISOString(),
    })));
  });

  app.get("/m/api/integration", async (request, reply) => {
    return reply.send(await scoped(request, (tx, s) => integrationStatus(tx, s.merchantId!, s.livemode)));
  });

  // ---------------------------------------------------------------- settings: keys

  app.get("/m/api/keys", async (request, reply) => {
    const keys = await scoped(request, (tx) => tx`
      SELECT key_id, kind, livemode, public_value, display, created_at, created_by, last_used_at, revoked_at
      FROM api_keys ORDER BY livemode DESC, kind, created_at DESC`);
    return reply.send({ keys, tag_base_url: config.tagBaseUrl, api_url: config.publicApiUrl, merchant_id: session(request).merchantId });
  });

  app.post("/m/api/keys", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const body = z.object({ kind: z.enum(["public", "secret"]), mode: z.enum(["test", "live"]) }).safeParse(request.body);
    if (!body.success) return bad(reply, "kind (public|secret) and mode (test|live) are required.");
    const livemode = body.data.mode === "live";
    const s = session(request);
    const out = await withMerchant(deps.app, s.merchantId, async (tx) => {
      if (livemode) {
        const [d] = await tx`SELECT 1 FROM merchant_domains WHERE verified_at IS NOT NULL LIMIT 1`;
        if (!d) return { error: "Verify a domain before creating live keys." };
      }
      const active = await tx`SELECT key_id FROM api_keys WHERE kind = ${body.data.kind} AND livemode = ${livemode} AND revoked_at IS NULL`;
      if (active.length >= 2) return { error: `You already have two active ${body.data.mode} ${body.data.kind} keys. Revoke one first.` };
      const value = generateKey(body.data.kind, livemode);
      const [k] = await tx`
        INSERT INTO api_keys (merchant_id, kind, livemode, key_hash, public_value, display, created_by)
        VALUES (${s.merchantId}, ${body.data.kind}, ${livemode}, ${hashKey(value)}, ${body.data.kind === "public" ? value : null}, ${displayKey(value)}, ${`user:${s.email}`})
        RETURNING key_id`;
      await audit(tx, s, "key.created", { kind: body.data.kind, livemode, display: displayKey(value) });
      return { key_id: k!.key_id, value };
    });
    if ("error" in out) return bad(reply, out.error!);
    return reply.status(201).send({ ...out, shown_once: body.data.kind === "secret" });
  });

  app.post<{ Params: { id: string } }>("/m/api/keys/:id/revoke", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const s = session(request);
    const rows = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const r = await tx`UPDATE api_keys SET revoked_at = now() WHERE key_id = ${request.params.id}::uuid AND revoked_at IS NULL RETURNING display, kind, livemode`;
      if (r.length) await audit(tx, s, "key.revoked", r[0]!);
      return r;
    }).catch(() => []);
    if (!rows.length) return reply.status(404).send({ error: { code: "not_found", message: "No such active key." } });
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- settings: domains

  app.get("/m/api/domains", async (request, reply) => {
    const domains = await scoped(request, (tx) => tx`SELECT domain_id, host, verification_token, verified_at, verified_method, last_checked_at, created_at FROM merchant_domains ORDER BY created_at`);
    return reply.send({ domains: domains.map((d) => ({ ...d, txt_record: `${VERIFY_PREFIX}${d.verification_token}`, meta_tag: `<meta name="uhoney-verify" content="${d.verification_token}">` })) });
  });

  app.post("/m/api/domains", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const host = normaliseHost(String((request.body as any)?.host ?? ""));
    if (!host) return bad(reply, "Enter a public domain such as shop.example.com.");
    const s = session(request);
    const out = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const count = await tx`SELECT count(*)::int AS n FROM merchant_domains`;
      if (count[0]!.n >= 20) return null;
      const [d] = await tx`
        INSERT INTO merchant_domains (merchant_id, host, verification_token) VALUES (${s.merchantId}, ${host}, ${randomString(24)})
        ON CONFLICT (merchant_id, host) DO UPDATE SET host = EXCLUDED.host RETURNING domain_id, host, verification_token`;
      await audit(tx, s, "domain.added", { host });
      return d;
    });
    if (!out) return bad(reply, "At most 20 domains.");
    return reply.status(201).send({ ...out, txt_record: `${VERIFY_PREFIX}${out.verification_token}`, meta_tag: `<meta name="uhoney-verify" content="${out.verification_token}">` });
  });

  app.post<{ Params: { id: string } }>("/m/api/domains/:id/verify", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const s = session(request);
    const [d] = await withMerchant(deps.app, s.merchantId, (tx) => tx`SELECT domain_id, host, verification_token, verified_at FROM merchant_domains WHERE domain_id = ${request.params.id}::uuid`).catch(() => []);
    if (!d) return reply.status(404).send({ error: { code: "not_found", message: "No such domain." } });
    if (d.verified_at) return reply.send({ verified: true, method: null });
    const method = await verifyDomain(d.host, d.verification_token);
    const result = await withMerchant(deps.app, s.merchantId, async (tx) => {
      await tx`UPDATE merchant_domains SET last_checked_at = now() WHERE domain_id = ${d.domain_id}`;
      if (!method) return { verified: false };
      try {
        await tx`UPDATE merchant_domains SET verified_at = now(), verified_method = ${method} WHERE domain_id = ${d.domain_id}`;
      } catch {
        return { verified: false, error: "This domain is already verified by another uHoney account." };
      }
      await audit(tx, s, "domain.verified", { host: d.host, method });
      // First verified domain: issue the live public key so the tag snippet is ready.
      const [pk] = await tx`SELECT 1 FROM api_keys WHERE kind = 'public' AND livemode = true AND revoked_at IS NULL`;
      if (!pk) {
        const value = generateKey("public", true);
        await tx`INSERT INTO api_keys (merchant_id, kind, livemode, key_hash, public_value, display, created_by) VALUES (${s.merchantId}, 'public', true, ${hashKey(value)}, ${value}, ${displayKey(value)}, 'system')`;
      }
      return { verified: true, method };
    });
    return reply.send(result);
  });

  app.delete<{ Params: { id: string } }>("/m/api/domains/:id", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const s = session(request);
    const r = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const rows = await tx`DELETE FROM merchant_domains WHERE domain_id = ${request.params.id}::uuid RETURNING host`;
      if (rows.length) await audit(tx, s, "domain.removed", { host: rows[0]!.host });
      return rows;
    }).catch(() => []);
    if (!r.length) return reply.status(404).send({ error: { code: "not_found", message: "No such domain." } });
    return reply.send({ ok: true });
  });

  // ---------------------------------------------------------------- settings: team

  app.get("/m/api/team", async (request, reply) => {
    const out = await scoped(request, async (tx) => ({
      users: await tx`SELECT user_id, email, name, role, disabled, created_at, last_login_at FROM merchant_users ORDER BY created_at`,
      invites: await tx`SELECT email, role, created_at, expires_at FROM merchant_invites WHERE used_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    }));
    return reply.send(out);
  });

  app.post("/m/api/team/invites", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;
    const body = z.object({ email: z.string().trim().email().max(254), role: z.enum(["owner", "developer", "analyst"]) }).safeParse(request.body);
    if (!body.success) return bad(reply, "A valid email and role are required.");
    const s = session(request);
    const token = randomString(40);
    await withMerchant(deps.app, s.merchantId, async (tx) => {
      await tx`INSERT INTO merchant_invites (token_hash, merchant_id, email, role, created_by, expires_at)
               VALUES (${sha256(token)}, ${s.merchantId}, ${body.data.email.toLowerCase()}, ${body.data.role}, ${`user:${s.email}`}, ${new Date(Date.now() + 7 * 86400_000)})`;
      await audit(tx, s, "invite.created", { email: body.data.email.toLowerCase(), role: body.data.role });
    });
    return reply.status(201).send({ invite_url: `${config.dashboardUrl}/m/invite/${token}`, expires_in_days: 7 });
  });

  app.patch<{ Params: { id: string } }>("/m/api/team/:id", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;
    const body = z.object({ role: z.enum(["owner", "developer", "analyst"]).optional(), disabled: z.boolean().optional() }).safeParse(request.body);
    if (!body.success) return bad(reply, "Invalid change.");
    const s = session(request);
    if (request.params.id === s.userId) return bad(reply, "You can't change your own role or disable yourself.");
    const r = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const rows = await tx`UPDATE merchant_users SET role = coalesce(${body.data.role ?? null}, role), disabled = coalesce(${body.data.disabled ?? null}, disabled)
                            WHERE user_id = ${request.params.id}::uuid RETURNING email, role, disabled`;
      if (rows.length) {
        if (body.data.disabled) await tx`DELETE FROM merchant_user_sessions WHERE user_id = ${request.params.id}::uuid`;
        await audit(tx, s, "user.updated", rows[0]!);
      }
      return rows;
    }).catch(() => []);
    if (!r.length) return reply.status(404).send({ error: { code: "not_found", message: "No such user." } });
    return reply.send({ ok: true, user: r[0] });
  });

  // ---------------------------------------------------------------- settings: webhooks

  app.get("/m/api/webhooks", async (request, reply) => {
    const out = await scoped(request, async (tx, s) => ({
      endpoints: await tx`SELECT endpoint_id, livemode, url, secret_display, events, created_at, disabled_at FROM webhook_endpoints WHERE livemode = ${s.livemode} AND disabled_at IS NULL ORDER BY created_at`,
      deliveries: await tx`SELECT event_id, type, status, attempts, last_status, last_error, is_test, created_at, delivered_at FROM webhook_deliveries WHERE livemode = ${s.livemode} ORDER BY created_at DESC LIMIT 30`,
    }));
    return reply.send(out);
  });

  app.post("/m/api/webhooks", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const body = z.object({ url: z.string().url().max(500).refine((u) => u.startsWith("https://"), "The URL must start with https://"), mode: z.enum(["test", "live"]) }).safeParse(request.body);
    if (!body.success) return bad(reply, body.error.issues[0]?.message ?? "A https URL and mode are required.");
    const s = session(request);
    const secret = generateWebhookSecret();
    const out = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const count = await tx`SELECT count(*)::int AS n FROM webhook_endpoints WHERE disabled_at IS NULL`;
      if (count[0]!.n >= 5) return null;
      const [e] = await tx`INSERT INTO webhook_endpoints (merchant_id, livemode, url, secret_encrypted, secret_display)
                           VALUES (${s.merchantId}, ${body.data.mode === "live"}, ${body.data.url}, ${encrypt(config.encryptionKey, secret)}, ${displayKey(secret)})
                           RETURNING endpoint_id`;
      await audit(tx, s, "webhook.created", { url: body.data.url, livemode: body.data.mode === "live" });
      return e;
    });
    if (!out) return bad(reply, "At most 5 webhook endpoints.");
    return reply.status(201).send({ endpoint_id: out.endpoint_id, secret, shown_once: true });
  });

  app.delete<{ Params: { id: string } }>("/m/api/webhooks/:id", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const s = session(request);
    const r = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const rows = await tx`UPDATE webhook_endpoints SET disabled_at = now() WHERE endpoint_id = ${request.params.id}::uuid AND disabled_at IS NULL RETURNING url`;
      if (rows.length) await audit(tx, s, "webhook.disabled", { url: rows[0]!.url });
      return rows;
    }).catch(() => []);
    if (!r.length) return reply.status(404).send({ error: { code: "not_found", message: "No such endpoint." } });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/m/api/webhooks/:id/test", async (request, reply) => {
    if (!requireRole(request, reply, "developer")) return;
    const s = session(request);
    const ids = await withMerchant(deps.app, s.merchantId, async (tx) => {
      const [e] = await tx`SELECT endpoint_id, livemode FROM webhook_endpoints WHERE endpoint_id = ${request.params.id}::uuid AND disabled_at IS NULL`;
      if (!e) return [];
      const now = new Date().toISOString();
      const sample = {
        assessment_id: "as_TestTestTestTestTest", merchant_id: s.merchantId, livemode: e.livemode, final: true, created_at: now, updated_at: now,
        order: { id: "test_order", amount: 1000, currency: "EUR" }, driver: "agent_then_human", handover: { page: "/checkout/payment", at: now },
        automation_type: "in_browser_agent", agent: { id: "claude-in-chrome", operator: "Anthropic", verified: false, verification: null },
        score: 0.97, confidence: "high", reasons: [{ code: "jump_clicks", text: "This is a test webhook from the uHoney dashboard" }],
        signals_used: { client: true, server: true }, scorer_version: "test",
        decision: "allow", legitimacy: { evaluated: false, score: null, reasons: [] },
        intent: { status: "not_provided", score: null, violations: [] }, evidence_id: null,
      } satisfies Assessment;
      return enqueueEvent(tx, s.merchantId, e.livemode, "assessment.updated", { assessment: sample, previous: null }, { endpointId: e.endpoint_id, isTest: true });
    }).catch(() => []);
    if (!ids.length) return reply.status(404).send({ error: { code: "not_found", message: "No such endpoint." } });
    return reply.status(202).send({ event_id: ids[0] });
  });

  // ---------------------------------------------------------------- settings: policy

  app.get("/m/api/policy", async (request, reply) => {
    const [m] = await scoped(request, (tx) => tx`SELECT policy FROM merchants`);
    return reply.send({ policy: { ...DEFAULT_POLICY, ...(m?.policy ?? {}) }, default: DEFAULT_POLICY });
  });

  app.put("/m/api/policy", async (request, reply) => {
    if (!requireRole(request, reply, "owner")) return;
    const body = policySchema.safeParse(request.body);
    if (!body.success) return bad(reply, "Each setting must be allow, review or challenge.");
    const s = session(request);
    await withMerchant(deps.app, s.merchantId, async (tx) => {
      await tx`UPDATE merchants SET policy = ${tx.json(body.data as any)} WHERE merchant_id = ${s.merchantId}`;
      await audit(tx, s, "policy.updated", body.data);
    });
    return reply.send({ policy: body.data });
  });
}
