import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { collectRequest, TAG_EVENTS } from "@honeypot/merchant-contract";
import { withMerchant } from "@honeypot/merchant-db";
import type { Deps } from "../context.js";
import { authenticateKey } from "../keys.js";
import { ApiFailure, sendError } from "../errors.js";
import { signToken, verifyToken, newSessionId, TOKEN_REFRESH_MS } from "../tokens.js";
import { identifyRequest } from "../sensing.js";
import { ipHash } from "../crypto.js";
import { normalisePath } from "../scoring/visits.js";
import { RateLimiter } from "../ratelimit.js";

const MAX_BODY = 64 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const perVisitor = new RateLimiter(240, 60_000);
const perKey = new RateLimiter(20_000, 60_000);

/** Hosts a key may send beacons from: registered domains (live: verified only), plus localhost for test keys. */
export async function originAllowed(tx: any, merchantId: string, livemode: boolean, origin: string | undefined): Promise<{ ok: boolean; host: string | null }> {
  if (!origin) return { ok: false, host: null };
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, host: null };
    host = u.hostname.toLowerCase();
    if (!livemode && LOCAL_HOSTS.has(host)) return { ok: true, host };
    if (u.protocol !== "https:") return { ok: false, host };
  } catch {
    return { ok: false, host: null };
  }
  const rows = await tx`
    SELECT 1 FROM merchant_domains WHERE merchant_id = ${merchantId} AND host = ${host}
      ${livemode ? tx`AND verified_at IS NOT NULL` : tx``} LIMIT 1`;
  return { ok: rows.length > 0, host };
}

function cors(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;
  if (origin) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
  }
}

export function registerCollect(app: FastifyInstance, deps: Deps) {
  app.options("/v1/collect", async (request, reply) => {
    cors(request, reply);
    reply.header("Access-Control-Allow-Methods", "POST");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
    reply.header("Access-Control-Max-Age", "86400");
    return reply.status(204).send();
  });

  app.post("/v1/collect", { bodyLimit: MAX_BODY }, async (request, reply) => {
    cors(request, reply);
    reply.header("Cache-Control", "no-store");
    let body: unknown = request.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return sendError(request, reply, "invalid_request", "Body must be JSON."); }
    }
    const parsed = collectRequest.safeParse(body);
    if (!parsed.success) return sendError(request, reply, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid beacon.");
    const b = parsed.data;
    if (b.kind === "event" && !(TAG_EVENTS as readonly string[]).includes(String(b.data.name))) {
      return sendError(request, reply, "invalid_request", `Unknown event. Use one of: ${TAG_EVENTS.join(", ")}.`);
    }

    try {
      const key = await authenticateKey(deps.app, b.site_key, "public");
      const ip = request.ip;
      if (perKey.hit(key.keyId) < 0 || perVisitor.hit(`${key.keyId}|${ip}`) < 0) {
        reply.header("RateLimit-Limit", String(perVisitor.max));
        return sendError(request, reply, "rate_limited", "Too many beacons.");
      }
      const userAgent = (request.headers["user-agent"] as string | undefined)?.slice(0, 1024) ?? null;
      const acceptLanguage = (request.headers["accept-language"] as string | undefined)?.slice(0, 256) ?? null;
      const network = b.kind === "page" ? await deps.network.lookup(ip, 300) : null;
      const identity = b.kind === "page" ? await identifyRequest({ ip, userAgent, network }) : null;

      return await withMerchant(deps.app, key.merchantId, async (tx) => {
        const origin = await originAllowed(tx, key.merchantId, key.livemode, request.headers.origin);
        if (!origin.ok) throw new ApiFailure("origin_not_allowed", key.livemode
          ? `Origin ${origin.host ?? "(none)"} is not a verified domain for this site key.`
          : `Origin ${origin.host ?? "(none)"} is not registered. Add it under Settings → Domains (localhost is always allowed with test keys).`);

        const check = verifyToken(deps.config.tokenSecret, b.session_token);
        const valid = check.ok && check.claims.m === key.merchantId && check.claims.k === key.keyId && check.claims.l === key.livemode;
        const sessionId = valid ? check.claims.s : newSessionId();
        const renew = !valid || check.claims.e * 1000 - Date.now() < TOKEN_REFRESH_MS;
        const issued = renew ? signToken(deps.config.tokenSecret, { m: key.merchantId, k: key.keyId, s: sessionId, l: key.livemode }) : { token: b.session_token!, claims: check.ok ? check.claims : null! };

        const data: Record<string, unknown> = b.kind === "event"
          ? { name: b.data.name, order_id: typeof b.data.order_id === "string" ? b.data.order_id.slice(0, 128) : null, t: b.t ?? null }
          : b.kind === "page"
            ? { t: b.t ?? null, spa: b.data.spa === true, sdk: b.sdk ?? null }
            : { ...b.data, clientT: b.t ?? null, sdk: b.sdk ?? null, v: b.v ?? 1 };
        await tx`
          INSERT INTO merchant_events (merchant_id, livemode, session_id, kind, name, page_view_id, path, origin, ip, ip_hash, user_agent, accept_language, identity, data)
          VALUES (${key.merchantId}, ${key.livemode}, ${sessionId}, ${b.kind}, ${b.kind === "event" ? String(b.data.name) : null}, ${b.pl ?? null},
                  ${normalisePath(b.path)}, ${request.headers.origin ?? null}, ${ip}, ${ipHash(deps.config.ipHashSecret, key.merchantId, ip)},
                  ${userAgent}, ${acceptLanguage}, ${identity ? tx.json(identity as any) : null}, ${tx.json(data as any)})`;
        await tx`UPDATE api_keys SET last_used_at = now() WHERE key_id = ${key.keyId} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
        return reply.send({ session_token: issued.token, expires_at: new Date(issued.claims.e * 1000).toISOString() });
      });
    } catch (err) {
      if (err instanceof ApiFailure) return sendError(request, reply, err.code, err.message);
      throw err;
    }
  });
}
