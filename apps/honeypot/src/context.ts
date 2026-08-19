import "fastify";

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
  startedAtMs: number;
  visitorId: string;
  actorId: string;
  sessionId: string;
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
