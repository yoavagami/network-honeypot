import { resolveDatabaseUrl } from "@honeypot/db";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: resolveDatabaseUrl("honeypot_role", "HONEYPOT_DB_PASSWORD"),
  // Separate connection for the CRM search feature (docs/VULNERABILITY.md) — deliberately
  // required as its own literal env var rather than going through resolveDatabaseUrl(), which
  // always prefers a bare DATABASE_URL if one is set — that would silently hand this feature
  // the main honeypot_role connection instead of the scoped honeypot_crm_role one.
  crmDatabaseUrl: required("CRM_DATABASE_URL"),
  crmSearchVulnerable: process.env.CRM_SEARCH_VULNERABLE === "true",
  // Backdoor/webshell bait (docs/VULNERABILITY.md) — no separate DB role needed, this only ever
  // reads a fixed in-code dictionary and writes normal events through the existing pipeline.
  backdoorBaitEnabled: process.env.BACKDOOR_BAIT_ENABLED === "true",
  ipHashSecret: required("IP_HASH_SECRET"),
  cookieSecret: required("COOKIE_SECRET"),
  rawIpRetentionDays: Number(process.env.RAW_IP_RETENTION_DAYS ?? 7),
  eventRetentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 90),
  geolocationEnabled: process.env.GEOLOCATION_ENABLED === "true",
  // See packages/detection/src/fingerprint.ts's resolveClientIp() for why this exists and why
  // it must stay opt-in — only true on the Render deployment (render.yaml), never a default.
  trustCfConnectingIp: process.env.TRUST_CF_CONNECTING_IP === "true",
  queueCapacity: Number(process.env.INGESTION_QUEUE_CAPACITY ?? 5000),
  queueFlushIntervalMs: Number(process.env.INGESTION_FLUSH_INTERVAL_MS ?? 500),
  queueFlushBatchSize: Number(process.env.INGESTION_FLUSH_BATCH_SIZE ?? 200),
  correlationIntervalMs: Number(process.env.CORRELATION_INTERVAL_MS ?? 5000),
  canaryRefreshIntervalMs: Number(process.env.CANARY_REFRESH_INTERVAL_MS ?? 30000),
  healthCheckIntervalMs: Number(process.env.HEALTH_CHECK_INTERVAL_MS ?? 60_000),
  // "Ingestion stalled" means the queue has backed-up work but hasn't successfully flushed to
  // the DB in this long — e.g. Postgres unreachable. Deliberately not "no traffic received",
  // since organic honeypot traffic is naturally bursty/idle and that alone isn't a failure.
  ingestionStallThresholdMs: Number(process.env.INGESTION_STALL_THRESHOLD_MS ?? 5 * 60_000),

  // --- Alerting (docs/ROADMAP.md Phase 2, brief §36) — all delivery targets optional; alerts
  // are always recorded as ALERT_TRIGGERED events regardless of whether any delivery target is
  // configured. Thresholds are configurable per the brief's "allow administrators to configure
  // thresholds" requirement.
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  alertSlackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL || null,
  alertEmail:
    process.env.ALERT_EMAIL_TO && process.env.SMTP_HOST
      ? {
          to: process.env.ALERT_EMAIL_TO,
          from: process.env.ALERT_EMAIL_FROM || process.env.ALERT_EMAIL_TO,
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          user: process.env.SMTP_USER || undefined,
          password: process.env.SMTP_PASSWORD || undefined,
        }
      : null,
  alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS ?? 15 * 60_000),
  alertThresholds: {
    highRequestRatePerMinute: Number(process.env.ALERT_HIGH_REQUEST_RATE_THRESHOLD ?? 100),
    authFailureBurst: Number(process.env.ALERT_AUTH_FAILURE_THRESHOLD ?? 20),
    largeScaleEnumeration: Number(process.env.ALERT_ENUMERATION_THRESHOLD ?? 50),
  },
} as const;
