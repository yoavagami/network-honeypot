import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../context.js";
import { buildTag } from "../tag.js";

const GENERATED = fileURLToPath(new URL("../../generated/", import.meta.url));
const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));

/** Generated docs (scripts/build-integrate-docs.ts) with {{PLACEHOLDERS}} filled from config. */
function render(file: string, deps: Deps): string | null {
  const path = file.startsWith("public:") ? PUBLIC + file.slice(7) : GENERATED + file;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .replaceAll("{{API_URL}}", deps.config.publicApiUrl)
    .replaceAll("{{TAG_URL}}", `${deps.config.tagBaseUrl}/v1/tag.js`)
    .replaceAll("{{DASHBOARD_URL}}", deps.config.dashboardUrl)
    .replaceAll("{{DOCS_URL}}", `${deps.config.tagBaseUrl}/docs/integrate`)
    .replaceAll("{{AGENT_URL}}", `${deps.config.tagBaseUrl}/integrate/v1/agent.md`)
    .replaceAll("{{TAG_BASE}}", deps.config.tagBaseUrl)
    .replaceAll("{{TAG_HOST}}", new URL(deps.config.tagBaseUrl).host)
    .replaceAll("{{API_HOST}}", new URL(deps.config.publicApiUrl).host);
}

export function registerStatic(app: FastifyInstance, deps: Deps) {
  const tag = buildTag(deps.config.publicApiUrl);
  app.get("/v1/tag.js", async (request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("ETag", tag.etag);
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    if (request.headers["if-none-match"] === tag.etag) return reply.status(304).send();
    return reply.type("application/javascript; charset=utf-8").send(tag.body);
  });

  const page = (url: string, file: string, type: string, cache = "public, max-age=300") =>
    app.get(url, async (_request, reply) => {
      const body = render(file, deps);
      if (body === null) return reply.status(404).send({ error: { code: "not_found", message: "Not built yet" } });
      reply.header("Cache-Control", cache);
      if (type.startsWith("text/html")) reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      return reply.type(type).send(body);
    });
  page("/docs/integrate", "developer.html", "text/html; charset=utf-8");
  page("/integrate/v1/agent.md", "agent.md", "text/markdown; charset=utf-8");
  page("/integrate/v1/openapi.json", "openapi.json", "application/json; charset=utf-8");
  page("/integrate/changelog.md", "changelog.md", "text/markdown; charset=utf-8");
  page("/llms.txt", "llms.txt", "text/plain; charset=utf-8");
  page("/merchants", "public:merchants.html", "text/html; charset=utf-8");
  app.get("/healthz", async (_r, reply) => reply.send({ ok: true }));
}
