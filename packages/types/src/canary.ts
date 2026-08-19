import { z } from "zod";

export const CANARY_TYPES = ["api_key", "internal_url", "credential", "token", "object_id"] as const;
export const CanaryTypeSchema = z.enum(CANARY_TYPES);
export type CanaryType = z.infer<typeof CanaryTypeSchema>;

export const CanaryObjectSchema = z.object({
  canaryId: z.string().uuid(),
  canaryType: CanaryTypeSchema,
  value: z.string(),
  plantedLocation: z.string(),
  createdAt: z.string().datetime(),
  active: z.boolean(),
});
export type CanaryObject = z.infer<typeof CanaryObjectSchema>;

export const CanaryEventSchema = z.object({
  canaryEventId: z.string().uuid(),
  canaryId: z.string().uuid(),
  actorId: z.string().uuid(),
  requestId: z.string().uuid(),
  createdAt: z.string().datetime(),
  usageContext: z.string(),
});
export type CanaryEvent = z.infer<typeof CanaryEventSchema>;
