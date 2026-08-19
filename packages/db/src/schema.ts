import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  numeric,
  inet,
  bigserial,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// NOTE: table shapes here mirror packages/db/migrations/0001_init.sql exactly. The SQL file is
// the source of truth for DDL (including partitioning); this file exists so app code gets typed
// query building via drizzle-orm. Keep the two in sync by hand — see docs/DATA_MODEL.md.

export const actors = pgTable("actors", {
  actorId: uuid("actor_id").primaryKey(),
  firstSeenAt: timestamptz("first_seen_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  confidence: text("confidence").notNull(),
  riskScore: integer("risk_score").notNull(),
  totalRequests: bigint("total_requests", { mode: "number" }),
  uniquePaths: integer("unique_paths").notNull(),
  label: text("label"),
  notes: text("notes"),
});

export const actorSignals = pgTable("actor_signals", {
  id: bigserial("id", { mode: "number" }),
  actorId: uuid("actor_id").notNull(),
  signalType: text("signal_type").notNull(),
  signalValue: text("signal_value").notNull(),
  firstSeenAt: timestamptz("first_seen_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  occurrenceCount: integer("occurrence_count").notNull(),
});

export const sessions = pgTable("sessions", {
  sessionId: uuid("session_id").primaryKey(),
  actorId: uuid("actor_id").notNull(),
  visitorId: uuid("visitor_id").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  ipHash: text("ip_hash").notNull(),
  userAgentRaw: text("user_agent_raw"),
  userAgentFingerprint: text("user_agent_fingerprint"),
  authenticatedAs: text("authenticated_as"),
});

export const requests = pgTable("requests", {
  requestId: uuid("request_id").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  actorId: uuid("actor_id").notNull(),
  sessionId: uuid("session_id"),
  ipHash: text("ip_hash").notNull(),
  ipRaw: inet("ip_raw"),
  sourcePort: integer("source_port"),
  method: text("method").notNull(),
  scheme: text("scheme").notNull(),
  host: text("host").notNull(),
  path: text("path").notNull(),
  queryString: text("query_string"),
  httpVersion: text("http_version"),
  statusCode: integer("status_code").notNull(),
  requestBytes: integer("request_bytes").notNull(),
  responseBytes: integer("response_bytes").notNull(),
  durationMs: numeric("duration_ms"),
  userAgentRaw: text("user_agent_raw"),
  userAgentFingerprint: text("user_agent_fingerprint"),
  referer: text("referer"),
  origin: text("origin"),
  accept: text("accept"),
  acceptLanguage: text("accept_language"),
  acceptEncoding: text("accept_encoding"),
  contentType: text("content_type"),
  forwardedForClientSupplied: text("forwarded_for_client_supplied"),
  tlsVersion: text("tls_version"),
  tlsCipher: text("tls_cipher"),
  alpn: text("alpn"),
  endpoint: text("endpoint").notNull(),
  applicationComponent: text("application_component").notNull(),
  riskScore: integer("risk_score").notNull(),
});

export const events = pgTable("events", {
  eventId: uuid("event_id").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  requestId: uuid("request_id"),
  actorId: uuid("actor_id").notNull(),
  sessionId: uuid("session_id"),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  riskScore: integer("risk_score").notNull(),
  source: text("source").notNull(),
  metadata: jsonb("metadata"),
});

export const detections = pgTable("detections", {
  detectionId: uuid("detection_id").primaryKey(),
  actorId: uuid("actor_id").notNull(),
  detectionType: text("detection_type").notNull(),
  confidence: numeric("confidence").notNull(),
  evidence: jsonb("evidence"),
  firstEventAt: timestamptz("first_event_at").notNull(),
  lastEventAt: timestamptz("last_event_at").notNull(),
  eventCount: integer("event_count").notNull(),
  acknowledged: boolean("acknowledged").notNull(),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: timestamptz("acknowledged_at"),
});

export const canaryObjects = pgTable("canary_objects", {
  canaryId: uuid("canary_id").primaryKey(),
  canaryType: text("canary_type").notNull(),
  value: text("value").notNull(),
  plantedLocation: text("planted_location").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  active: boolean("active").notNull(),
});

export const canaryEvents = pgTable("canary_events", {
  canaryEventId: uuid("canary_event_id").primaryKey(),
  canaryId: uuid("canary_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  requestId: uuid("request_id"),
  createdAt: timestamptz("created_at").notNull(),
  usageContext: text("usage_context").notNull(),
});

export const syntheticObjects = pgTable("synthetic_objects", {
  objectId: uuid("object_id").primaryKey(),
  objectType: text("object_type").notNull(),
  publicRef: text("public_ref").notNull(),
  data: jsonb("data"),
  createdAt: timestamptz("created_at").notNull(),
});

export const adminUsers = pgTable("admin_users", {
  adminUserId: uuid("admin_user_id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  mfaSecret: text("mfa_secret"),
  createdAt: timestamptz("created_at").notNull(),
  lastLoginAt: timestamptz("last_login_at"),
  disabled: boolean("disabled").notNull(),
});

export const adminSessions = pgTable("admin_sessions", {
  adminSessionId: text("admin_session_id").primaryKey(),
  adminUserId: uuid("admin_user_id").notNull(),
  csrfToken: text("csrf_token").notNull(),
  createdAt: timestamptz("created_at").notNull(),
  lastSeenAt: timestamptz("last_seen_at").notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  ipHash: text("ip_hash"),
});

export const adminAuditLog = pgTable("admin_audit_log", {
  auditId: bigserial("audit_id", { mode: "number" }),
  adminUserId: uuid("admin_user_id"),
  createdAt: timestamptz("created_at").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  ipHash: text("ip_hash"),
  metadata: jsonb("metadata"),
});
