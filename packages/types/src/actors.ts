import { z } from "zod";
import { ActorConfidenceSchema, BotClassificationSchema, ClassificationSchema } from "./events.js";

export const ActorSignalTypeSchema = z.enum(["ip_hash", "ua_fingerprint", "visitor_id", "tls_tuple"]);
export type ActorSignalType = z.infer<typeof ActorSignalTypeSchema>;

export const ActorSummarySchema = z.object({
  actorId: z.string().uuid(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  confidence: ActorConfidenceSchema,
  riskScore: z.number().int().min(0).max(100),
  totalRequests: z.number().int(),
  uniquePaths: z.number().int(),
  label: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ActorSummary = z.infer<typeof ActorSummarySchema>;

export const ActorProfileSchema = ActorSummarySchema.extend({
  signals: z.array(
    z.object({
      signalType: ActorSignalTypeSchema,
      signalValue: z.string(),
      firstSeenAt: z.string().datetime(),
      lastSeenAt: z.string().datetime(),
      occurrenceCount: z.number().int(),
    })
  ),
  botClassification: ClassificationSchema.extend({ label: BotClassificationSchema }).nullable(),
  sessionCount: z.number().int(),
  ipCount: z.number().int(),
  userAgentCount: z.number().int(),
  canaryTriggerCount: z.number().int(),
  authAttemptCount: z.number().int(),
  enumerationEventCount: z.number().int(),
});
export type ActorProfile = z.infer<typeof ActorProfileSchema>;

/** One entry in an actor's chronological attack timeline. */
export const TimelineEntrySchema = z.object({
  at: z.string().datetime(),
  kind: z.enum(["request", "event"]),
  label: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  eventType: z.string().nullable(),
  severity: z.string().nullable(),
  requestId: z.string().uuid().nullable(),
  eventId: z.string().uuid().nullable(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
