import { z } from "zod";

/**
 * Normalized HTTP request event — see docs/DATA_MODEL.md `requests` table.
 * This is what the honeypot app's request/response hooks build for every inbound request.
 */
export const RequestRecordSchema = z.object({
  requestId: z.string().uuid(),
  createdAt: z.string().datetime(),
  actorId: z.string().uuid(),
  sessionId: z.string().uuid().nullable(),
  ipHash: z.string(),
  ipRaw: z.string().nullable(),
  sourcePort: z.number().int().nullable(),
  method: z.string(),
  scheme: z.string(),
  host: z.string(),
  path: z.string(),
  queryString: z.string().nullable(),
  httpVersion: z.string(),
  statusCode: z.number().int(),
  requestBytes: z.number().int(),
  responseBytes: z.number().int(),
  durationMs: z.number(),
  userAgentRaw: z.string().nullable(),
  userAgentFingerprint: z.string().nullable(),
  referer: z.string().nullable(),
  origin: z.string().nullable(),
  accept: z.string().nullable(),
  acceptLanguage: z.string().nullable(),
  acceptEncoding: z.string().nullable(),
  contentType: z.string().nullable(),
  forwardedForClientSupplied: z.string().nullable(),
  tlsVersion: z.string().nullable(),
  tlsCipher: z.string().nullable(),
  alpn: z.string().nullable(),
  endpoint: z.string(),
  applicationComponent: z.string(),
  riskScore: z.number().int().min(0).max(100),
});
export type RequestRecord = z.infer<typeof RequestRecordSchema>;

/** Redacted summary of a JSON request body — never the raw body. See DATA_MODEL.md §5. */
export const BodyShapeSchema = z.object({
  keys: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      lengthBucket: z.string().optional(),
    })
  ),
  byteLength: z.number().int(),
});
export type BodyShape = z.infer<typeof BodyShapeSchema>;

export const PasswordShapeSchema = z.object({
  lengthBucket: z.enum(["0", "1-7", "8-11", "12-15", "16-23", "24-31", "32+"]),
  hasDigit: z.boolean(),
  hasSymbol: z.boolean(),
  hasUpper: z.boolean(),
  hasLower: z.boolean(),
});
export type PasswordShape = z.infer<typeof PasswordShapeSchema>;
