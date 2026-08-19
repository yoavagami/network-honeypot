export interface RecentRequest {
  atMs: number;
  path: string;
  /** Route template with :id placeholders, e.g. "/api/v1/users/:id" — set by the route matcher. */
  pathTemplate: string | null;
  /** Extracted path params, e.g. { id: "42" } */
  pathParams: Record<string, string>;
  method: string;
  statusCode: number;
  userAgent: string | null;
  eventTypes: string[];
  queryParams: Record<string, string>;
  fetchedDocsFirst?: boolean;
}

export interface DetectionResult {
  detectionType:
    | "reconnaissance"
    | "enumeration"
    | "fuzzing"
    | "scanner"
    | "auth_probing"
    | "api_probing"
    | "bot_classification";
  confidence: number;
  evidence: Record<string, unknown>;
  eventCount: number;
  firstEventAtMs: number;
  lastEventAtMs: number;
}

export function withinWindow(items: RecentRequest[], nowMs: number, windowMs: number): RecentRequest[] {
  return items.filter((r) => nowMs - r.atMs <= windowMs);
}
