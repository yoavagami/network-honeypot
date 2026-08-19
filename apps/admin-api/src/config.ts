import { resolveDatabaseUrl } from "@honeypot/db";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const VALID_SAME_SITE = ["strict", "lax", "none"] as const;
type SameSite = (typeof VALID_SAME_SITE)[number];

function sameSiteFromEnv(): SameSite {
  const value = (process.env.ADMIN_SESSION_SAMESITE ?? "strict").toLowerCase();
  if ((VALID_SAME_SITE as readonly string[]).includes(value)) return value as SameSite;
  throw new Error(`ADMIN_SESSION_SAMESITE must be one of ${VALID_SAME_SITE.join(", ")}, got "${value}"`);
}

export const config = {
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: resolveDatabaseUrl("admin_api_role", "ADMIN_API_DB_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),
  ipHashSecret: required("IP_HASH_SECRET"),
  adminWebOrigin: process.env.ADMIN_WEB_ORIGIN ?? "http://localhost:8081",
  // "strict" is correct and sufficient when admin-web and admin-api share a site (the SSH-tunnel
  // AWS default, where both are reached via localhost, or the AWS same-origin-proxy public
  // option). Cross-origin public deployments (Render, where each service gets its own hostname)
  // need "none" or the browser silently drops the session cookie on every admin-api call — see
  // docs/DEPLOY_RENDER.md. Never "none" without Secure, which we always set.
  sessionCookieSameSite: sameSiteFromEnv(),
  honeypotInternalUrl: process.env.HONEYPOT_INTERNAL_URL ?? "http://localhost:8080",
  sessionIdleTimeoutMs: Number(process.env.ADMIN_SESSION_IDLE_MS ?? 30 * 60 * 1000),
  sessionAbsoluteTimeoutMs: Number(process.env.ADMIN_SESSION_ABSOLUTE_MS ?? 12 * 60 * 60 * 1000),
} as const;
