import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MerchantTx } from "@honeypot/merchant-db";
import type { Deps } from "../context.js";
import { safeEqual, sha256 } from "../crypto.js";
import { displayKey, generateKey, hashKey } from "../keys.js";
import { randomString } from "../ids.js";
import { overview, listVisits, listOrders, getOrder, type Scope } from "../queries.js";
import { visitDetail } from "./dashboard.js";

/**
 * Internal admin API — only for admin-api, never routed by nginx. admin-api authenticates the
 * honeypot admin (superadmin/admin), writes its own access log, and forwards here with the shared
 * MERCHANT_INTERNAL_TOKEN plus the admin's name for our audit trail. Runs as merchant_admin, so it
 * sees every merchant; `merchant_id` narrows any list to one.
 */
const MERCHANT_RE = /^mer_[0-9A-HJKMNP-TV-Z]{8}$/;

export function registerInternal(app: FastifyInstance, deps: Deps) {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const token = request.headers["x-internal-token"];
    if (typeof token !== "string" || !safeEqual(token, deps.config.internalToken)) {
      reply.callNotFound();
      return reply;
    }
  });

  const adminName = (r: FastifyRequest) => {
    const n = r.headers["x-admin-user"];
    return typeof n === "string" && /^[A-Za-z0-9_.@-]{1,64}$/.test(n) ? n : "unknown";
  };
  const scopeOf = (r: FastifyRequest): Scope | null => {
    const q = r.query as Record<string, string>;
    if (q.merchant_id && !MERCHANT_RE.test(q.merchant_id)) return null;
    return { merchantId: q.merchant_id || null, livemode: q.mode === "live" };
  };
  const tx = <T>(fn: (tx: MerchantTx) => Promise<T>) => deps.admin.begin(fn) as Promise<T>;
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
  const auditRow = (t: MerchantTx, merchantId: string, admin: string, action: string, detail: object = {}) =>
    t`INSERT INTO merchant_audit (merchant_id, actor, action, detail) VALUES (${merchantId}, ${`admin:${admin}`}, ${action}, ${t.json(detail as any)})`;

  async function createInvite(t: MerchantTx, merchantId: string, email: string, role: string, admin: string) {
    const token = randomString(40);
    await t`INSERT INTO merchant_invites (token_hash, merchant_id, email, role, created_by, expires_at)
            VALUES (${sha256(token)}, ${merchantId}, ${email.toLowerCase()}, ${role}, ${`admin:${admin}`}, ${new Date(Date.now() + 7 * 86400_000)})`;
    return `${deps.config.dashboardUrl}/m/invite/${token}`;
  }

  app.get("/internal/merchants", async (request, reply) => {
    const status = (request.query as Record<string, string>).status;
    const rows = await tx((t) => t`
      SELECT m.merchant_id, m.status, m.company, m.website, m.contact_email, m.platform, m.monthly_checkouts, m.created_at, m.reviewed_at, m.reviewed_by,
             (SELECT count(*)::int FROM merchant_users u WHERE u.merchant_id = m.merchant_id) AS users,
             (SELECT count(*)::int FROM merchant_domains d WHERE d.merchant_id = m.merchant_id AND d.verified_at IS NOT NULL) AS verified_domains,
             (SELECT count(*)::int FROM merchant_visits v WHERE v.merchant_id = m.merchant_id AND v.last_at > now() - interval '7 days') AS visits_7d,
             (SELECT count(*)::int FROM assessments a WHERE a.merchant_id = m.merchant_id AND a.created_at > now() - interval '7 days') AS assessments_7d,
             (SELECT max(e.created_at) FROM merchant_events e WHERE e.merchant_id = m.merchant_id) AS last_event_at
      FROM merchants m
      ${status ? t`WHERE m.status = ${status}` : t``}
      ORDER BY (m.status = 'pending') DESC, m.created_at DESC LIMIT 500`);
    return reply.send({ merchants: rows });
  });

  app.get<{ Params: { id: string } }>("/internal/merchants/:id", async (request, reply) => {
    if (!MERCHANT_RE.test(request.params.id)) return notFound(reply);
    const id = request.params.id;
    const out = await tx(async (t) => {
      const [m] = await t`SELECT * FROM merchants WHERE merchant_id = ${id}`;
      if (!m) return null;
      return {
        merchant: m,
        users: await t`SELECT user_id, email, name, role, disabled, created_at, last_login_at FROM merchant_users WHERE merchant_id = ${id} ORDER BY created_at`,
        invites: await t`SELECT email, role, created_by, created_at, expires_at, used_at FROM merchant_invites WHERE merchant_id = ${id} ORDER BY created_at DESC LIMIT 20`,
        domains: await t`SELECT host, verified_at, verified_method, created_at FROM merchant_domains WHERE merchant_id = ${id} ORDER BY created_at`,
        keys: await t`SELECT kind, livemode, display, created_at, last_used_at, revoked_at FROM api_keys WHERE merchant_id = ${id} ORDER BY created_at DESC`,
        webhooks: await t`SELECT url, livemode, created_at, disabled_at FROM webhook_endpoints WHERE merchant_id = ${id} ORDER BY created_at DESC`,
        audit: await t`SELECT actor, action, detail, created_at FROM merchant_audit WHERE merchant_id = ${id} ORDER BY created_at DESC LIMIT 50`,
      };
    });
    if (!out) return notFound(reply);
    return reply.send(out);
  });

  app.post<{ Params: { id: string } }>("/internal/merchants/:id/approve", async (request, reply) => {
    if (!MERCHANT_RE.test(request.params.id)) return notFound(reply);
    const admin = adminName(request);
    const out = await tx(async (t) => {
      const [m] = await t`UPDATE merchants SET status = 'approved', reviewed_at = now(), reviewed_by = ${admin}
                          WHERE merchant_id = ${request.params.id} AND status IN ('pending', 'declined') RETURNING merchant_id, contact_email`;
      if (!m) return null;
      // Test public key straight away, so the tag snippet is ready on first sign-in.
      const value = generateKey("public", false);
      await t`INSERT INTO api_keys (merchant_id, kind, livemode, key_hash, public_value, display, created_by)
              VALUES (${m.merchant_id}, 'public', false, ${hashKey(value)}, ${value}, ${displayKey(value)}, ${`admin:${admin}`})`;
      const inviteUrl = await createInvite(t, m.merchant_id, m.contact_email, "owner", admin);
      await auditRow(t, m.merchant_id, admin, "merchant.approved");
      return { merchant_id: m.merchant_id, invite_url: inviteUrl, invite_email: m.contact_email };
    });
    if (!out) return reply.status(409).send({ error: { code: "invalid_state", message: "Only pending or declined merchants can be approved." } });
    return reply.send(out);
  });

  app.post<{ Params: { id: string } }>("/internal/merchants/:id/decline", async (request, reply) => {
    if (!MERCHANT_RE.test(request.params.id)) return notFound(reply);
    const admin = adminName(request);
    const ok = await tx(async (t) => {
      const r = await t`UPDATE merchants SET status = 'declined', reviewed_at = now(), reviewed_by = ${admin} WHERE merchant_id = ${request.params.id} AND status = 'pending' RETURNING 1`;
      if (r.length) await auditRow(t, request.params.id, admin, "merchant.declined");
      return r.length > 0;
    });
    if (!ok) return reply.status(409).send({ error: { code: "invalid_state", message: "Only pending merchants can be declined." } });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/internal/merchants/:id/status", async (request, reply) => {
    if (!MERCHANT_RE.test(request.params.id)) return notFound(reply);
    const body = z.object({ status: z.enum(["approved", "suspended"]) }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: "invalid_request", message: "status must be approved or suspended" } });
    const admin = adminName(request);
    const ok = await tx(async (t) => {
      const r = await t`UPDATE merchants SET status = ${body.data.status} WHERE merchant_id = ${request.params.id} AND status IN ('approved', 'suspended') RETURNING 1`;
      if (r.length) {
        if (body.data.status === "suspended") await t`DELETE FROM merchant_user_sessions WHERE merchant_id = ${request.params.id}`;
        await auditRow(t, request.params.id, admin, `merchant.${body.data.status === "suspended" ? "suspended" : "reactivated"}`);
      }
      return r.length > 0;
    });
    if (!ok) return reply.status(409).send({ error: { code: "invalid_state", message: "Merchant must be approved or suspended." } });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/internal/merchants/:id/invite", async (request, reply) => {
    if (!MERCHANT_RE.test(request.params.id)) return notFound(reply);
    const body = z.object({ email: z.string().email().max(254).optional(), role: z.enum(["owner", "developer", "analyst"]).default("owner") }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: { code: "invalid_request", message: "Invalid email or role" } });
    const admin = adminName(request);
    const out = await tx(async (t) => {
      const [m] = await t`SELECT merchant_id, contact_email FROM merchants WHERE merchant_id = ${request.params.id} AND status = 'approved'`;
      if (!m) return null;
      const email = body.data.email ?? m.contact_email;
      const url = await createInvite(t, m.merchant_id, email, body.data.role, admin);
      await auditRow(t, m.merchant_id, admin, "invite.created", { email, role: body.data.role });
      return { invite_url: url, invite_email: email };
    });
    if (!out) return reply.status(409).send({ error: { code: "invalid_state", message: "Approve the merchant first." } });
    return reply.send(out);
  });

  // Cross-merchant data, optionally filtered to one merchant.
  app.get("/internal/overview", async (request, reply) => {
    const s = scopeOf(request);
    if (!s) return notFound(reply);
    const days = Math.min(Math.max(Number((request.query as any).days) || 7, 1), 90);
    return reply.send(await tx((t) => overview(t, s, days)));
  });
  app.get("/internal/visits", async (request, reply) => {
    const s = scopeOf(request);
    if (!s) return notFound(reply);
    const q = request.query as Record<string, string>;
    return reply.send({ visits: await tx((t) => listVisits(t, s, { driver: q.driver || undefined, agentsOnly: q.agents === "1", before: q.before, limit: Number(q.limit) || 50 })) });
  });
  app.get<{ Params: { id: string } }>("/internal/visits/:id", async (request, reply) => {
    const s = scopeOf(request);
    if (!s) return notFound(reply);
    const out = await tx((t) => visitDetail(t, s, request.params.id));
    return out ? reply.send(out) : notFound(reply);
  });
  app.get("/internal/orders", async (request, reply) => {
    const s = scopeOf(request);
    if (!s) return notFound(reply);
    const q = request.query as Record<string, string>;
    return reply.send({ orders: await tx((t) => listOrders(t, s, { action: q.action || undefined, driver: q.driver || undefined, before: q.before, limit: Number(q.limit) || 50 })) });
  });
  app.get<{ Params: { id: string } }>("/internal/orders/:id", async (request, reply) => {
    const s = scopeOf(request);
    if (!s) return notFound(reply);
    const out = await tx((t) => getOrder(t, s, request.params.id));
    return out ? reply.send(out) : notFound(reply);
  });
}
