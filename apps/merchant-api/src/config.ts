/**
 * merchant-api configuration. Read once at startup by loadConfig(); tests build their own.
 * Secrets must be long random values (openssl rand -hex 32).
 */
export interface MerchantConfig {
  port: number;
  host: string;
  appDatabaseUrl: string;
  adminDatabaseUrl: string;
  /** Signs session tokens (st_…). */
  tokenSecret: string;
  /** 32-byte hex key for AES-256-GCM (webhook secrets at rest). */
  encryptionKey: string;
  /** Keys the per-merchant IP hash. */
  ipHashSecret: string;
  /** Shared with admin-api for /internal/* — never exposed through nginx. */
  internalToken: string;
  /** Public base URLs used in docs, snippets and links. */
  publicApiUrl: string;
  tagBaseUrl: string;
  dashboardUrl: string;
  /** Origins allowed to call the merchant dashboard API with cookies. */
  dashboardOrigins: string[];
  cookieSecure: boolean;
  trustProxy: number | boolean;
  workersEnabled: boolean;
  scorerIntervalMs: number;
  webhookIntervalMs: number;
  /** Test only: allow webhook delivery to private addresses (local mock servers). */
  allowPrivateWebhookTargets: boolean;
}

const required = (env: NodeJS.ProcessEnv, name: string, minLength = 1) => {
  const v = env[name];
  if (!v || v.length < minLength) throw new Error(`${name} is required${minLength > 1 ? ` (at least ${minLength} characters)` : ""}`);
  return v;
};
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MerchantConfig {
  const encryptionKey = required(env, "MERCHANT_ENCRYPTION_KEY");
  if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) throw new Error("MERCHANT_ENCRYPTION_KEY must be 64 hex characters");
  const dashboardUrl = trimSlash(env.MERCHANT_DASHBOARD_URL ?? "https://app.uhoney.shop");
  return {
    port: Number(env.PORT ?? 8095),
    host: env.HOST ?? "0.0.0.0",
    appDatabaseUrl: required(env, "MERCHANT_APP_DATABASE_URL"),
    adminDatabaseUrl: required(env, "MERCHANT_ADMIN_DATABASE_URL"),
    tokenSecret: required(env, "MERCHANT_TOKEN_SECRET", 32),
    encryptionKey,
    ipHashSecret: required(env, "IP_HASH_SECRET", 16),
    internalToken: required(env, "MERCHANT_INTERNAL_TOKEN", 32),
    publicApiUrl: trimSlash(env.MERCHANT_PUBLIC_API_URL ?? "https://api.uhoney.shop"),
    tagBaseUrl: trimSlash(env.MERCHANT_TAG_BASE_URL ?? "https://uhoney.shop"),
    dashboardUrl,
    dashboardOrigins: (env.MERCHANT_DASHBOARD_ORIGINS ?? dashboardUrl).split(",").map((s) => trimSlash(s.trim())).filter(Boolean),
    cookieSecure: env.MERCHANT_COOKIE_SECURE !== "false",
    trustProxy: env.TRUST_PROXY_HOPS ? Number(env.TRUST_PROXY_HOPS) : 1,
    workersEnabled: env.MERCHANT_WORKERS_ENABLED !== "false",
    scorerIntervalMs: Number(env.MERCHANT_SCORER_INTERVAL_MS ?? 3000),
    webhookIntervalMs: Number(env.MERCHANT_WEBHOOK_INTERVAL_MS ?? 5000),
    allowPrivateWebhookTargets: false,
  };
}
