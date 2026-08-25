import "fastify";
import type { RiskFlag } from "@honeypot/detection";

/** Per-request deception/telemetry context — route handlers mutate this; the response hook
 * reads it to finalize the request/event rows. See docs/ARCHITECTURE.md §4. */
export interface HoneypotRequestContext {
  endpoint: string;
  applicationComponent: string;
  isAdminArea: boolean;
  routeMatched: boolean;
  methodAllowed: boolean;
  paramValidationFailed: boolean;
  canaryHaystacks: Array<string | null | undefined>;
  authEvent?: { type: "LOGIN_FAILURE" | "PASSWORD_RESET_ATTEMPT"; username?: string };
  extraEventTypes: string[];
  /** Risk flags a route handler determined from its own request-time logic (e.g. CRM search
   * SQLi detection, which needs the actual query outcome) — merged with evaluateInline()'s
   * structural flags before scoring. See ingestion/capture.ts's finalizeRequest. */
  extraRiskFlags: RiskFlag[];
  startedAtMs: number;
  visitorId: string;
  actorId: string;
  sessionId: string;
  /** Resolved via resolveClientIp() — NOT necessarily request.ip; see capture.ts's onRequest
   * hook and packages/detection/src/fingerprint.ts for why the two can differ on Render. */
  ip: string;
  ipHash: string;
  uaFingerprint: string;
  isAuthenticated?: boolean;
  authenticatedUsername?: string;
  fetchedDocsFirst?: boolean;
  skipIngestion?: boolean;
  pathTemplate?: string;
  pathParams?: Record<string, string>;
}

declare module "fastify" {
  interface FastifyRequest {
    hp: HoneypotRequestContext;
  }
}
