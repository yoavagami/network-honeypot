import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Deps } from "./context.js";
import { registerCollect } from "./routes/collect.js";
import { registerServerApi } from "./routes/server.js";
import { registerDashboard } from "./routes/dashboard.js";
import { registerInternal } from "./routes/internal.js";
import { registerStatic } from "./routes/static.js";
import { sendError } from "./errors.js";

/** Builds the merchant API (tests call this with their own database and config). */
export async function buildApp(deps: Deps, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.trustProxy,
    bodyLimit: 64 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
  });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => done(null, body));
  await app.register(cookie);

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    if (request.url.startsWith("/v1/") || request.url.startsWith("/m/api/") || request.url.startsWith("/internal/")) {
      if (!reply.getHeader("content-security-policy")) reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });

  app.setErrorHandler((err: any, request, reply) => {
    if (err.validation || err.statusCode === 400 || err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || err instanceof SyntaxError) {
      return sendError(request, reply, "invalid_request", "The request body could not be read.");
    }
    if (err.statusCode === 413) return sendError(request, reply, "invalid_request", "The request body is too large.");
    request.log.error({ msg: "unhandled error", err: err?.message });
    return sendError(request, reply, "internal_error", "Something went wrong on our side. Fail open: let the checkout continue.");
  });
  app.setNotFoundHandler((request, reply) => sendError(request, reply, "not_found", "No such endpoint."));

  registerInternal(app, deps);
  registerDashboard(app, deps);
  registerCollect(app, deps);
  registerServerApi(app, deps);
  registerStatic(app, deps);
  return app;
}
