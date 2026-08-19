import { resolveDatabaseUrl } from "@honeypot/db";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: resolveDatabaseUrl("admin_api_role", "ADMIN_API_DB_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),
  ipHashSecret: required("IP_HASH_SECRET"),
  adminWebOrigin: process.env.ADMIN_WEB_ORIGIN ?? "http://localhost:8081",
  honeypotInternalUrl: process.env.HONEYPOT_INTERNAL_URL ?? "http://localhost:8080",
  sessionIdleTimeoutMs: Number(process.env.ADMIN_SESSION_IDLE_MS ?? 30 * 60 * 1000),
  sessionAbsoluteTimeoutMs: Number(process.env.ADMIN_SESSION_ABSOLUTE_MS ?? 12 * 60 * 60 * 1000),
} as const;
