import type { FastifyInstance, FastifyError } from "fastify";
import { notFoundPage, serverErrorPage } from "../render/pages.js";

/**
 * Known route patterns + their allowed methods, used only to distinguish INVALID_METHOD
 * (path exists, method doesn't) from INVALID_ROUTE (path doesn't exist at all) for detection
 * purposes — see docs/DETECTION.md §2. This list is deliberately independent of Fastify's own
 * routing table so a route-registration typo can't silently misclassify telemetry.
 */
const KNOWN_ROUTES: Array<{ pattern: RegExp; methods: string[] }> = [
  { pattern: /^\/$/, methods: ["GET"] },
  { pattern: /^\/login$/, methods: ["GET", "POST"] },
  { pattern: /^\/register$/, methods: ["GET", "POST"] },
  { pattern: /^\/reset-password$/, methods: ["GET", "POST"] },
  { pattern: /^\/profile$/, methods: ["GET"] },
  { pattern: /^\/search$/, methods: ["GET"] },
  { pattern: /^\/docs$/, methods: ["GET"] },
  { pattern: /^\/privacy$/, methods: ["GET"] },
  { pattern: /^\/admin$/, methods: ["GET"] },
  { pattern: /^\/admin\/dashboard$/, methods: ["GET"] },
  { pattern: /^\/admin\/login$/, methods: ["POST"] },
  { pattern: /^\/api\/v1$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/health$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/config$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/users$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/users\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/objects$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/objects\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/api\/v1\/search$/, methods: ["GET"] },
  { pattern: /^\/robots\.txt$/, methods: ["GET"] },
  { pattern: /^\/sitemap\.xml$/, methods: ["GET"] },
  { pattern: /^\/health$/, methods: ["GET"] },
  { pattern: /^\/status$/, methods: ["GET"] },
];

export function registerNotFoundHandler(app: FastifyInstance) {
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split("?")[0]!;
    const known = KNOWN_ROUTES.find((r) => r.pattern.test(path));

    if (known) {
      request.hp.routeMatched = true;
      request.hp.methodAllowed = false;
      reply.status(405);
    } else {
      request.hp.routeMatched = false;
      request.hp.methodAllowed = true;
      reply.status(404);
    }
    request.hp.endpoint = known ? "invalid.method" : "invalid.route";
    request.hp.applicationComponent = "site";

    if (request.headers.accept?.includes("application/json") || path.startsWith("/api/")) {
      reply.send({ error: { code: known ? "method_not_allowed" : "not_found", message: "Not found" } });
      return;
    }
    reply.type("text/html").send(notFoundPage());
  });

  app.setErrorHandler(async (err: FastifyError, request, reply) => {
    request.log.error({ msg: "unhandled error", err: err.message });
    request.hp.endpoint = "error";
    request.hp.applicationComponent = "site";
    const statusCode = err.statusCode ?? 500;
    reply.status(statusCode);
    if (path_startsWithApi(request.url)) {
      const code = statusCode < 500 ? "bad_request" : "internal_error";
      const message = statusCode < 500 ? "The request could not be processed" : "Internal server error";
      reply.send({ error: { code, message } });
      return;
    }
    reply.type("text/html").send(serverErrorPage(statusCode));
  });
}

function path_startsWithApi(url: string): boolean {
  return url.split("?")[0]!.startsWith("/api/");
}
