import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loadSession } from "./auth.js";
import { SESSION_COOKIE, CSRF_COOKIE } from "./routes/auth.js";

const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/system/health"]);

export function registerAuthMiddleware(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    request.adminSession = sessionId ? await loadSession(sessionId) : null;

    const path = request.url.split("?")[0]!;
    if (PUBLIC_PATHS.has(path)) return;
    if (!path.startsWith("/api/")) return;

    if (!request.adminSession) {
      reply.status(401).send({ error: { code: "unauthenticated", message: "Sign in required" } });
      return reply;
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const csrfHeader = request.headers["x-csrf-token"];
      const csrfCookie = request.cookies[CSRF_COOKIE];
      if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie || csrfHeader !== request.adminSession.csrfToken) {
        reply.status(403).send({ error: { code: "csrf_failed", message: "CSRF validation failed" } });
        return reply;
      }
    }
  });
}

const loginAttempts = new Map<string, { count: number; windowStart: number }>();
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

export function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export function requireCleanup(): void {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.windowStart > LOGIN_WINDOW_MS * 5) loginAttempts.delete(ip);
  }
}

export type { FastifyReply, FastifyRequest };
