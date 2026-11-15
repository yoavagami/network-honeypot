import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withMerchant, type MerchantSql } from "@honeypot/merchant-db";
import { sha256, safeEqual } from "./crypto.js";

export const SESSION_COOKIE = "uh_msid";
export const CSRF_COOKIE = "uh_mcsrf";
export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 12 * 3600_000;

export type MerchantRole = "owner" | "developer" | "analyst";
export interface MerchantSession { userId: string; merchantId: string; email: string; name: string; role: MerchantRole; company: string; csrfToken: string; sessionHash: string }

const RANK: Record<MerchantRole, number> = { analyst: 1, developer: 2, owner: 3 };
export const atLeast = (role: MerchantRole, min: MerchantRole) => RANK[role] >= RANK[min];

export async function createSession(sql: MerchantSql, userId: string, merchantId: string) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(24).toString("hex");
  await withMerchant(sql, merchantId, async (tx) => {
    await tx`INSERT INTO merchant_user_sessions (session_hash, user_id, merchant_id, csrf_token, expires_at)
             VALUES (${sha256(token)}, ${userId}, ${merchantId}, ${csrf}, ${new Date(Date.now() + ABSOLUTE_MS)})`;
    await tx`UPDATE merchant_users SET last_login_at = now() WHERE user_id = ${userId}`;
  });
  return { token, csrf };
}

export async function loadSession(sql: MerchantSql, token: string | undefined): Promise<MerchantSession | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = sha256(token);
  const [s] = await sql<any[]>`SELECT * FROM mk_session_lookup(${hash})`;
  if (!s || s.disabled || s.merchant_status !== "approved") return null;
  const now = Date.now();
  if (new Date(s.expires_at).getTime() < now || new Date(s.last_seen_at).getTime() + IDLE_MS < now) return null;
  if (now - new Date(s.last_seen_at).getTime() > 60_000) {
    await withMerchant(sql, s.merchant_id, (tx) => tx`UPDATE merchant_user_sessions SET last_seen_at = now() WHERE session_hash = ${hash}`);
  }
  return { userId: s.user_id, merchantId: s.merchant_id, email: s.email, name: s.name, role: s.role, company: s.company, csrfToken: s.csrf_token, sessionHash: hash };
}

export function setSessionCookies(reply: FastifyReply, secure: boolean, token: string, csrf: string) {
  const base = { path: "/", secure, sameSite: "strict" as const, maxAge: ABSOLUTE_MS / 1000 };
  reply.setCookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure, sameSite: "strict" });
  reply.clearCookie(CSRF_COOKIE, { path: "/", secure, sameSite: "strict" });
}

/** Double-submit CSRF: header must equal the cookie and the session's token. */
export function csrfOk(request: FastifyRequest, session: MerchantSession): boolean {
  const header = request.headers["x-csrf-token"];
  const cookie = request.cookies[CSRF_COOKIE];
  return typeof header === "string" && typeof cookie === "string" && safeEqual(header, cookie) && safeEqual(header, session.csrfToken);
}
