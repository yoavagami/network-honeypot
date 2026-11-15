import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assessRequest, feedbackRequest, ID_PATTERNS, type Policy } from "@honeypot/merchant-contract";
import { withMerchant, type MerchantTx } from "@honeypot/merchant-db";
import type { Deps } from "../context.js";
import { authenticateKey, bearer, type KeyIdentity } from "../keys.js";
import { ApiFailure, sendError } from "../errors.js";
import { verifyToken, newSessionId } from "../tokens.js";
import { identifyRequest } from "../sensing.js";
import { ipHash, sha256 } from "../crypto.js";
import { newAssessmentId, visitIdFor } from "../ids.js";
import { merchantVisits } from "../scoring/visits.js";
import { loadSessionEvents, LOOKBACK_MS } from "../scoring/load.js";
import { verdictFor } from "../scoring/verdict.js";
import { assessmentBody } from "../assessmentBody.js";
import { integrationStatus } from "../status.js";
import { RateLimiter } from "../ratelimit.js";

const perKey = new RateLimiter(600, 1000);
/** Headers we never want: credentials of the merchant's own visitors. */
const DROP_HEADERS = new Set(["cookie", "authorization", "proxy-authorization", "set-cookie"]);

/** Authenticates a server call: secret key, optional Uhoney-Merchant cross-check, rate limit. */
async function serverAuth(deps: Deps, request: FastifyRequest): Promise<KeyIdentity> {
  const key = await authenticateKey(deps.app, bearer(request.headers.authorization), "secret");
  const claimed = request.headers["uhoney-merchant"];
  if (claimed !== undefined && claimed !== key.merchantId) throw new ApiFailure("merchant_mismatch", "Uhoney-Merchant does not match the merchant this key belongs to.");
  if (perKey.hit(key.keyId) < 0) throw new ApiFailure("rate_limited", "Too many requests for this key.");
  markKeyUsed(deps, key);
  return key;
}

/** Settings → Keys "last used": at most one write per key per minute, never on the request path. */
const lastMarked = new Map<string, number>();
function markKeyUsed(deps: Deps, key: KeyIdentity) {
  const now = Date.now();
  if (now - (lastMarked.get(key.keyId) ?? 0) < 60_000) return;
  lastMarked.set(key.keyId, now);
  void withMerchant(deps.app, key.merchantId, (tx) => tx`UPDATE api_keys SET last_used_at = now() WHERE key_id = ${key.keyId}`).catch(() => lastMarked.delete(key.keyId));
}

const stableJson = (v: unknown): string =>
  v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(stableJson).join(",")}]`
      : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(",")}}`;

async function merchantPolicy(tx: MerchantTx, merchantId: string): Promise<Partial<Policy>> {
  const [m] = await tx<{ policy: Partial<Policy> }[]>`SELECT policy FROM merchants WHERE merchant_id = ${merchantId}`;
  return m?.policy ?? {};
}

export function registerServerApi(app: FastifyInstance, deps: Deps) {
  const handle = (fn: (request: FastifyRequest, reply: FastifyReply, key: KeyIdentity) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      try {
        const key = await serverAuth(deps, request);
        return await fn(request, reply, key);
      } catch (err) {
        if (err instanceof ApiFailure) return sendError(request, reply, err.code, err.message);
        throw err;
      }
    };

  app.post("/v1/assess", handle(async (request, reply, key) => {
    const started = performance.now();
    const parsed = assessRequest.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendError(request, reply, "invalid_request", issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request.");
    }
    const body = parsed.data;
    const idemHeader = request.headers["idempotency-key"];
    const idempotencyKey = (typeof idemHeader === "string" && idemHeader.length > 0 ? idemHeader : body.order.id).slice(0, 128);
    const requestHash = sha256(stableJson(body));
    const headers = Object.fromEntries(Object.entries(body.request.headers).filter(([k]) => !DROP_HEADERS.has(k)));

    // Token: never an error. A token for another merchant, key mode or an expired one counts as invalid.
    const check = body.session_token ? verifyToken(deps.config.tokenSecret, body.session_token) : null;
    const tokenValid = Boolean(check?.ok && check.claims.m === key.merchantId && check.claims.l === key.livemode);
    const tokenStatus = !body.session_token ? "missing" : tokenValid ? "valid" : "invalid";
    const sessionId = tokenValid && check?.ok ? check.claims.s : newSessionId();

    const network = deps.network.cached(body.request.ip) ?? null;
    const identity = await identifyRequest({
      ip: body.request.ip, userAgent: body.request.user_agent, headers,
      method: body.request.method, path: body.request.path, host: body.request.host, wbaTimeoutMs: 150, network,
    });

    const result = await withMerchant(deps.app, key.merchantId, async (tx) => {
      const [existing] = await tx<{ request_hash: string; response: unknown }[]>`
        SELECT request_hash, response FROM assessments WHERE merchant_id = ${key.merchantId} AND livemode = ${key.livemode} AND idempotency_key = ${idempotencyKey}`;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new ApiFailure("idempotency_conflict", `Idempotency key ${idempotencyKey} was already used with a different request.`);
        return existing.response;
      }
      const [ev] = await tx<{ event_id: string }[]>`
        INSERT INTO merchant_events (merchant_id, livemode, session_id, kind, path, ip, ip_hash, user_agent, accept_language, identity, data)
        VALUES (${key.merchantId}, ${key.livemode}, ${sessionId}, 'assess', ${body.request.path?.split("?")[0]?.slice(0, 512) ?? null},
                ${body.request.ip}, ${ipHash(deps.config.ipHashSecret, key.merchantId, body.request.ip)}, ${body.request.user_agent},
                ${headers["accept-language"]?.slice(0, 256) ?? null}, ${tx.json(identity as any)},
                ${tx.json({ order: body.order, stage: body.stage, header_count: Object.keys(headers).length } as any)})
        RETURNING event_id`;
      const now = new Date();
      const events = await loadSessionEvents(tx, key.merchantId, key.livemode, [sessionId], new Date(now.getTime() - LOOKBACK_MS));
      const visit = merchantVisits(events).find((v) => v.requests.some((r) => r.request_id === ev!.event_id));
      if (!visit) throw new Error("assess: visit not built");
      const verdict = verdictFor(visit, now, tokenStatus === "invalid" ? ["session_token_invalid"] : []);
      const assessmentId = newAssessmentId();
      const response = assessmentBody({
        assessmentId, merchantId: key.merchantId, livemode: key.livemode, final: false, createdAt: now, updatedAt: now, order: body.order,
      }, verdict, await merchantPolicy(tx, key.merchantId));
      const serverMs = Math.round(performance.now() - started);
      await tx`
        INSERT INTO assessments (assessment_id, merchant_id, livemode, idempotency_key, request_hash, session_id, visit_id, order_id, amount, currency,
                                 token_status, header_count, server_ms, response, created_at, updated_at)
        VALUES (${assessmentId}, ${key.merchantId}, ${key.livemode}, ${idempotencyKey}, ${requestHash}, ${sessionId}, ${visitIdFor(key.merchantId, visit.id)},
                ${body.order.id}, ${body.order.amount}, ${body.order.currency}, ${tokenStatus}, ${Object.keys(headers).length}, ${serverMs},
                ${tx.json(response as any)}, ${now}, ${now})`;
      return response;
    }).catch(async (err) => {
      // Two concurrent calls with one idempotency key: the loser returns the winner's answer.
      if (err?.code === "23505") {
        const [row] = await withMerchant(deps.app, key.merchantId, (tx) => tx`SELECT request_hash, response FROM assessments WHERE merchant_id = ${key.merchantId} AND livemode = ${key.livemode} AND idempotency_key = ${idempotencyKey}`);
        if (row && row.request_hash === requestHash) return row.response;
        throw new ApiFailure("idempotency_conflict", `Idempotency key ${idempotencyKey} was already used with a different request.`);
      }
      throw err;
    });
    return reply.send(result);
  }));

  app.get<{ Params: { id: string } }>("/v1/assessments/:id", handle(async (request, reply, key) => {
    const id = (request.params as { id: string }).id;
    if (!ID_PATTERNS.assessment.test(id)) return sendError(request, reply, "not_found", "No such assessment.");
    const [row] = await withMerchant(deps.app, key.merchantId, (tx) => tx`SELECT response FROM assessments WHERE assessment_id = ${id} AND livemode = ${key.livemode}`);
    if (!row) return sendError(request, reply, "not_found", "No such assessment.");
    return reply.send(row.response);
  }));

  app.post("/v1/feedback", handle(async (request, reply, key) => {
    const parsed = feedbackRequest.safeParse(request.body);
    if (!parsed.success) return sendError(request, reply, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.");
    const f = parsed.data;
    const out = await withMerchant(deps.app, key.merchantId, async (tx) => {
      const [a] = f.assessment_id
        ? await tx`SELECT assessment_id, order_id FROM assessments WHERE assessment_id = ${f.assessment_id} AND livemode = ${key.livemode}`
        : await tx`SELECT assessment_id, order_id FROM assessments WHERE order_id = ${f.order_id!} AND livemode = ${key.livemode} ORDER BY created_at DESC LIMIT 1`;
      if (!a) return null;
      await tx`INSERT INTO feedback (merchant_id, livemode, assessment_id, order_id, outcome, note) VALUES (${key.merchantId}, ${key.livemode}, ${a.assessment_id}, ${a.order_id}, ${f.outcome}, ${f.note ?? null})`;
      return a.assessment_id as string;
    });
    if (!out) return sendError(request, reply, "not_found", "No assessment for that order.");
    return reply.status(202).send({ received: true, assessment_id: out });
  }));

  app.get("/v1/integration/status", handle(async (_request, reply, key) => {
    const status = await withMerchant(deps.app, key.merchantId, async (tx) => {
      const [k] = await tx`SELECT display FROM api_keys WHERE key_id = ${key.keyId}`;
      return integrationStatus(tx, key.merchantId, key.livemode, { display: k?.display ?? "sk_…" });
    });
    return reply.send(status);
  }));
}
