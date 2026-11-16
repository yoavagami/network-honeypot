import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { audit } from "../audit.js";

/**
 * Merchant platform, admin side. The data lives in the merchant database behind apps/merchant-api;
 * this forwards the signed-in admin's requests to its internal API (MERCHANT_INTERNAL_URL, shared
 * MERCHANT_INTERNAL_TOKEN) and audit-logs them here. Admins (both roles) see every merchant and
 * can filter by one; merchants themselves only ever see their own data, in their own dashboard.
 */
const MERCHANT_RE = /^mer_[0-9A-HJKMNP-TV-Z]{8}$/;
const ALLOWED_QUERY = new Set(["status", "merchant_id", "mode", "driver", "agents", "before", "limit", "days", "action", "path", "bucket", "lab", "labels"]);

async function forward(request: FastifyRequest, reply: FastifyReply, method: "GET" | "POST", path: string, body?: unknown) {
  if (!config.merchantInternalUrl || !config.merchantInternalToken) {
    return reply.status(503).send({ error: { code: "merchants_disabled", message: "The merchant service is not configured (MERCHANT_INTERNAL_URL / MERCHANT_INTERNAL_TOKEN)." } });
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries((request.query ?? {}) as Record<string, string>)) if (ALLOWED_QUERY.has(k) && typeof v === "string") q.set(k, v.slice(0, 64));
  const url = `${config.merchantInternalUrl}/internal/${path}${q.size ? `?${q}` : ""}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "x-internal-token": config.merchantInternalToken, "x-admin-user": request.adminSession!.username, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    return reply.status(res.status).type("application/json").send(text);
  } catch {
    return reply.status(502).send({ error: { code: "merchant_service_unavailable", message: "The merchant service did not answer." } });
  }
}

export function registerMerchantRoutes(app: FastifyInstance) {
  const id = (r: FastifyRequest) => (r.params as { id: string }).id;
  const filterMerchant = (r: FastifyRequest) => (r.query as Record<string, string> | undefined)?.merchant_id ?? null;
  const logView = (r: FastifyRequest, what: string, merchantId: string | null) =>
    merchantId ? audit(r.adminSession!.adminUserId, "view_merchant_data", merchantId, null, { what }) : Promise.resolve();

  app.get("/api/merchants", async (request, reply) => forward(request, reply, "GET", "merchants"));
  // Who opened the public merchant pages (raw IPs, 30 days): logged like any other data view.
  app.get("/api/merchant-site/hits", async (request, reply) => {
    await audit(request.adminSession!.adminUserId, "view_merchant_page_hits", null, null, {});
    return forward(request, reply, "GET", "page-hits");
  });

  app.get("/api/merchants/:id", async (request, reply) => {
    if (!MERCHANT_RE.test(id(request))) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    await logView(request, "merchant", id(request));
    return forward(request, reply, "GET", `merchants/${id(request)}`);
  });

  for (const action of ["approve", "decline", "status", "invite"] as const) {
    app.post(`/api/merchants/:id/${action}`, async (request, reply) => {
      if (!MERCHANT_RE.test(id(request))) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
      await audit(request.adminSession!.adminUserId, `merchant_${action}`, id(request), null, { body: action === "status" ? request.body : undefined });
      return forward(request, reply, "POST", `merchants/${id(request)}/${action}`, request.body ?? {});
    });
  }

  for (const kind of ["overview", "visits", "orders"] as const) {
    app.get(`/api/merchant-data/${kind}`, async (request, reply) => {
      await logView(request, kind, filterMerchant(request));
      return forward(request, reply, "GET", kind);
    });
    if (kind !== "overview") {
      app.get(`/api/merchant-data/${kind}/:id`, async (request, reply) => {
        if (!/^(vis|as)_[A-Za-z0-9]{20}$/.test(id(request))) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
        await logView(request, `${kind}:${id(request)}`, filterMerchant(request) ?? "all");
        return forward(request, reply, "GET", `${kind}/${id(request)}`);
      });
    }
  }
}
