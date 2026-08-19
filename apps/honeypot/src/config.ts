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
  ipHashSecret: required("IP_HASH_SECRET"),
  cookieSecret: required("COOKIE_SECRET"),
  rawIpRetentionDays: Number(process.env.RAW_IP_RETENTION_DAYS ?? 7),
  eventRetentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 90),
  geolocationEnabled: process.env.GEOLOCATION_ENABLED === "true",
  queueCapacity: Number(process.env.INGESTION_QUEUE_CAPACITY ?? 5000),
  queueFlushIntervalMs: Number(process.env.INGESTION_FLUSH_INTERVAL_MS ?? 500),
  queueFlushBatchSize: Number(process.env.INGESTION_FLUSH_BATCH_SIZE ?? 200),
  correlationIntervalMs: Number(process.env.CORRELATION_INTERVAL_MS ?? 5000),
  canaryRefreshIntervalMs: Number(process.env.CANARY_REFRESH_INTERVAL_MS ?? 30000),
} as const;
