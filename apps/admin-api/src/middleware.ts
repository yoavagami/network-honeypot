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

/**
 * Login rate limiting, keyed by both IP and username — see docs/SECURITY.md §2. Two keys
 * because either alone is bypassable: an attacker rotating source IPs (credential stuffing via
 * a botnet/proxy pool) defeats a pure per-IP limit, while a single shared office IP with
 * multiple legitimate admins would make a pure per-username-blind-to-IP limit too aggressive.
 * In-memory and per-process — acceptable for this project's stakes (the real defense is
 * Argon2id + a generated, non-guessable password); a multi-instance deployment would need this
 * moved to shared storage (Redis) to stay effective, not a Phase 1 requirement.
 */
const attemptsByKey = new Map<string, { count: number; windowStart: number }>();
const IP_WINDOW_MS = 60_000;
const IP_MAX_ATTEMPTS = 5;
const USERNAME_WINDOW_MS = 15 * 60_000;
const USERNAME_MAX_ATTEMPTS = 5;

function checkAndIncrement(key: string, windowMs: number, maxAttempts: number): boolean {
  const now = Date.now();
  const entry = attemptsByKey.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    attemptsByKey.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > maxAttempts;
}

export function loginRateLimited(ip: string, username: string): boolean {
  // Always check both — short-circuiting on the first true would under-count the other key.
  const ipLimited = checkAndIncrement(`ip:${ip}`, IP_WINDOW_MS, IP_MAX_ATTEMPTS);
  const usernameLimited = username ? checkAndIncrement(`user:${username.toLowerCase()}`, USERNAME_WINDOW_MS, USERNAME_MAX_ATTEMPTS) : false;
  return ipLimited || usernameLimited;
}

export function clearLoginAttempts(ip: string, username: string): void {
  attemptsByKey.delete(`ip:${ip}`);
  if (username) attemptsByKey.delete(`user:${username.toLowerCase()}`);
}

export function requireCleanup(): void {
  const now = Date.now();
  const maxWindow = Math.max(IP_WINDOW_MS, USERNAME_WINDOW_MS) * 5;
  for (const [key, entry] of attemptsByKey) {
    if (now - entry.windowStart > maxWindow) attemptsByKey.delete(key);
  }
}

export type { FastifyReply, FastifyRequest };
