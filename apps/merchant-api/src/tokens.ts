import { randomUUID } from "node:crypto";
import { ID_PATTERNS } from "@honeypot/merchant-contract";
import { hmacB64url, safeEqual } from "./crypto.js";

/**
 * Session tokens: st_<payload>.<signature>. The payload binds the visitor session to one merchant,
 * one site key and one mode; the HMAC makes it unforgeable; `e` makes it expire. The session id
 * survives refreshes, so a visit keeps one id while its token is renewed.
 */
export const TOKEN_TTL_MS = 2 * 3600_000;
/** Renew when less than this is left. */
export const TOKEN_REFRESH_MS = 30 * 60_000;

export interface TokenClaims { m: string; k: string; s: string; l: boolean; e: number }

export function signToken(secret: string, claims: Omit<TokenClaims, "e"> & { e?: number }, now = Date.now()): { token: string; claims: TokenClaims } {
  const full: TokenClaims = { m: claims.m, k: claims.k, s: claims.s, l: claims.l, e: claims.e ?? Math.floor((now + TOKEN_TTL_MS) / 1000) };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  return { token: `st_${payload}.${hmacB64url(secret, `st.${payload}`)}`, claims: full };
}

export type TokenCheck = { ok: true; claims: TokenClaims } | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyToken(secret: string, token: string | undefined, now = Date.now()): TokenCheck {
  if (!token || !ID_PATTERNS.sessionToken.test(token)) return { ok: false, reason: "malformed" };
  const [payload, sig] = token.slice(3).split(".");
  if (!payload || !sig || !safeEqual(sig, hmacB64url(secret, `st.${payload}`))) return { ok: false, reason: "signature" };
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims?.e !== "number" || typeof claims.s !== "string" || typeof claims.m !== "string") return { ok: false, reason: "malformed" };
  if (claims.e * 1000 < now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

export const newSessionId = () => randomUUID();
