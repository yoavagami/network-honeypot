import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { hashIp, resolveClientIp } from "@honeypot/detection";
import { db } from "../db.js";
import { config } from "../config.js";
import { verifyPassword, createSession, destroySession } from "../auth.js";
import { audit } from "../audit.js";
import { loginRateLimited, clearLoginAttempts } from "../middleware.js";

const SESSION_COOKIE = "admin_session";
const CSRF_COOKIE = "csrf_token";

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    const ip = resolveClientIp(request.ip, request.headers["cf-connecting-ip"], config.trustCfConnectingIp);
    const ipHash = hashIp(ip, config.ipHashSecret);

    if (loginRateLimited(ip, username)) {
      reply.status(429).send({ error: { code: "rate_limited", message: "Too many attempts, try again shortly" } });
      return;
    }

    const [user] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.username, username)).limit(1);
    const ok = user && !user.disabled ? await verifyPassword(user.passwordHash, password) : false;

    if (!user || !ok) {
      await audit(user?.adminUserId ?? null, "login_failed", username, ipHash);
      reply.status(401).send({ error: { code: "invalid_credentials", message: "Invalid username or password" } });
      return;
    }

    clearLoginAttempts(ip, username);
    const session = await createSession(user.adminUserId, ipHash);
    await db.update(schema.adminUsers).set({ lastLoginAt: new Date() }).where(eq(schema.adminUsers.adminUserId, user.adminUserId));
    await audit(user.adminUserId, "login", null, ipHash);

    reply.setCookie(SESSION_COOKIE, session.adminSessionId, { httpOnly: true, secure: true, sameSite: config.sessionCookieSameSite, path: "/", maxAge: config.sessionAbsoluteTimeoutMs / 1000 });
    reply.setCookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, secure: true, sameSite: config.sessionCookieSameSite, path: "/", maxAge: config.sessionAbsoluteTimeoutMs / 1000 });
    reply.send({ username: session.username });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      await destroySession(sessionId);
      await audit(request.adminSession?.adminUserId ?? null, "logout", null, null);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (request, reply) => {
    if (!request.adminSession) {
      reply.status(401).send({ error: { code: "unauthenticated", message: "Not signed in" } });
      return;
    }
    reply.send({ username: request.adminSession.username });
  });
}

export { SESSION_COOKIE, CSRF_COOKIE };
