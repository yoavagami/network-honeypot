import { z } from "zod";

/**
 * Event taxonomy — see docs/DETECTION.md §1.
 * Adding a new event type is a one-line change to this array; every consumer
 * (detection engine, admin API, dashboard) is typed off this single source.
 */
export const EVENT_TYPES = [
  "HTTP_REQUEST",
  "HTTP_ERROR",
  "AUTH_PAGE_VIEW",
  "LOGIN_ATTEMPT",
  "LOGIN_FAILURE",
  "LOGIN_SUCCESS",
  "REGISTRATION_ATTEMPT",
  "PASSWORD_RESET_ATTEMPT",
  "API_REQUEST",
  "API_ERROR",
  "INVALID_ROUTE",
  "INVALID_METHOD",
  "INVALID_PARAMETER",
  "PARAMETER_ENUMERATION",
  "OBJECT_ENUMERATION",
  "ID_ENUMERATION",
  "PATH_ENUMERATION",
  "FILE_ACCESS_ATTEMPT",
  "ADMIN_PAGE_ACCESS",
  "ADMIN_LOGIN_ATTEMPT",
  "UPLOAD_ATTEMPT",
  "SUSPICIOUS_UPLOAD",
  "BOT_DETECTED",
  "SCANNER_DETECTED",
  "FUZZING_DETECTED",
  "RATE_LIMIT_TRIGGERED",
  "AUTOMATION_DETECTED",
  "SESSION_CREATED",
  "SESSION_CHANGED",
  "COOKIE_ANOMALY",
  "HEADER_ANOMALY",
  "SUSPICIOUS_USER_AGENT",
  "SUSPICIOUS_QUERY",
  "SUSPICIOUS_PAYLOAD",
  "ERROR_PROBE",
  "TECHNOLOGY_ENUMERATION",
  "ROBOTS_ACCESS",
  "SITEMAP_ACCESS",
  "API_DOCUMENTATION_ACCESS",
  "HEALTH_ENDPOINT_ACCESS",
  "DIRECT_IP_ACCESS",
  "HONEYPOT_TRIGGER",
  "CANARY_TRIGGERED",
  "ALERT_TRIGGERED",
  // CRM search SQLi telemetry (docs/VULNERABILITY.md) — behavioral, derived from actual query
  // outcomes (a real Postgres error, or a row count the query's own LIMIT should have made
  // impossible), never from matching signatures against the input text. See routes/crm.ts.
  "SQLI_PROBE",
  "SQLI_CONFIRMED",
  "DATA_EXTRACTION",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const DETECTION_TYPES = [
  "reconnaissance",
  "enumeration",
  "fuzzing",
  "scanner",
  "auth_probing",
  "api_probing",
  "bot_classification",
] as const;
export const DetectionTypeSchema = z.enum(DETECTION_TYPES);
export type DetectionType = z.infer<typeof DetectionTypeSchema>;

export const BOT_CLASSIFICATIONS = [
  "human_browser",
  "search_crawler",
  "ai_llm_agent",
  "security_scanner",
  "generic_bot",
  "script_http_library",
  "browser_automation",
  "unknown_automation",
  "likely_human",
] as const;
export const BotClassificationSchema = z.enum(BOT_CLASSIFICATIONS);
export type BotClassification = z.infer<typeof BotClassificationSchema>;

export const ACTOR_CONFIDENCE = ["low", "medium", "high"] as const;
export const ActorConfidenceSchema = z.enum(ACTOR_CONFIDENCE);
export type ActorConfidence = z.infer<typeof ActorConfidenceSchema>;

/** A single, structured emitted event — what the detection engine produces and the DB stores. */
export const EventRecordSchema = z.object({
  eventId: z.string().uuid(),
  createdAt: z.string().datetime(),
  requestId: z.string().uuid().nullable(),
  actorId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  eventType: EventTypeSchema,
  severity: SeveritySchema,
  riskScore: z.number().int().min(0).max(100),
  source: z.enum(["inline_rule", "correlation_worker", "canary"]),
  metadata: z.record(z.unknown()).default({}),
});
export type EventRecord = z.infer<typeof EventRecordSchema>;

/** A classification result that must always carry confidence + evidence — never bare fact. */
export const ClassificationSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string()),
});
export type Classification = z.infer<typeof ClassificationSchema>;
