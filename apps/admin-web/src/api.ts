declare global {
  interface Window {
    __ADMIN_API_URL__?: string;
  }
}

// Runtime config (set by admin-web-entrypoint.sh at container start) wins when explicitly
// present — including an explicit empty string, meaning "same origin, use relative /api paths"
// (the AWS same-origin-proxy deployment option). Falls back to the build-time
// VITE_ADMIN_API_URL when no runtime config was rendered at all (plain local dev, or the
// default docker-compose setup). See docs/DEPLOY_RENDER.md and docs/DEPLOYMENT.md.
const runtimeBase = typeof window !== "undefined" ? window.__ADMIN_API_URL__ : undefined;
const BASE = runtimeBase !== undefined ? runtimeBase : (import.meta.env.VITE_ADMIN_API_URL ?? "http://localhost:8090");

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrf = readCookie("csrf_token");
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(`${BASE}${path}`, { ...init, method, headers, credentials: "include" });
  if (!res.ok) {
    let code = "unknown_error";
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) => request<{ username: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/api/auth/me"),

  events: (params: Record<string, string> = {}) => request<{ data: EventRow[]; nextCursor: string | null }>(`/api/events?${new URLSearchParams(params)}`),
  event: (id: string) => request<{ event: EventRow; request: RequestRow | null; actor: ActorRow | null }>(`/api/events/${id}`),

  requests: (params: Record<string, string> = {}) => request<{ data: RequestLogRow[]; nextCursor: string | null }>(`/api/requests?${new URLSearchParams(params)}`),

  actors: (params: Record<string, string> = {}) => request<{ data: ActorRow[] }>(`/api/actors?${new URLSearchParams(params)}`),
  actor: (id: string) => request<ActorProfile>(`/api/actors/${id}`),
  actorTimeline: (id: string) => request<{ data: TimelineEntry[] }>(`/api/actors/${id}/timeline`),

  detections: (params: Record<string, string> = {}) => request<{ data: DetectionRow[] }>(`/api/detections?${new URLSearchParams(params)}`),
  ackDetection: (id: string) => request<{ ok: true }>(`/api/detections/${id}/ack`, { method: "POST" }),

  canaries: () => request<{ data: CanaryRow[] }>("/api/canaries"),

  overview: (range: string) => request<OverviewResponse>(`/api/analytics/overview?range=${range}`),
  traffic: (range: string) => request<{ data: Array<{ bucket: string; count: number; uniqueActors: number }> }>(`/api/analytics/traffic?range=${range}`),
  attacks: (range: string) => request<{ byDetectionType: Array<{ detectionType: string; count: number }>; riskDistribution: Array<{ bucket: string; count: number }> }>(`/api/analytics/attacks?range=${range}`),
  bots: (range: string) => request<{ data: Array<{ uaFingerprint: string | null; count: number; uniqueActors: number }> }>(`/api/analytics/bots?range=${range}`),
  geography: (range: string) => request<GeographyResponse>(`/api/analytics/geography?range=${range}`),
  heatmap: (range: string) => request<{ data: HeatmapPointRow[] }>(`/api/analytics/heatmap?range=${range}`),
  uniqueIps: (range: string) => request<{ data: IpBreakdownRow[] }>(`/api/analytics/ips?range=${range}`),
  uniqueUserAgents: (range: string) => request<{ data: UserAgentBreakdownRow[] }>(`/api/analytics/user-agents?range=${range}`),
  firstContact: () => request<{ data: FirstContactRow[] }>("/api/analytics/first-contact"),
  discoveryFunnel: (range: string) => request<DiscoveryFunnelResponse>(`/api/analytics/discovery-funnel?range=${range}`),
  vulnerabilities: (range: string) => request<{ data: VulnerabilityRow[] }>(`/api/analytics/vulnerabilities?range=${range}`),

  search: (q: string) => request<{ data: RequestRow[]; query: string }>(`/api/search?q=${encodeURIComponent(q)}`),

  health: () => request<{ status: string; components: Record<string, boolean> }>("/api/system/health"),
  ingestion: () => request<IngestionHealth>("/api/system/ingestion"),
};

export interface EventRow {
  eventId: string;
  createdAt: string;
  requestId: string | null;
  actorId: string;
  sessionId: string | null;
  eventType: string;
  severity: string;
  riskScore: number;
  source: string;
  metadata: Record<string, unknown>;
}

export interface RequestRow {
  requestId: string;
  createdAt: string;
  actorId: string;
  sessionId: string | null;
  ipHash: string;
  method: string;
  scheme: string;
  host: string;
  path: string;
  queryString: string | null;
  httpVersion: string | null;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: string;
  userAgentRaw: string | null;
  userAgentFingerprint: string | null;
  referer: string | null;
  tlsVersion: string | null;
  tlsCipher: string | null;
  alpn: string | null;
  endpoint: string;
  applicationComponent: string;
  riskScore: number;
}

export interface IpBreakdownRow {
  ipHash: string;
  /** Only populated if at least one request from this IP is within RAW_IP_RETENTION_DAYS. */
  latestIpRaw: string | null;
  requestCount: number;
  uniqueActors: number;
  firstSeen: string;
  lastSeen: string;
  maxRisk: number;
}

export interface UserAgentBreakdownRow {
  userAgent: string | null;
  requestCount: number;
  uniqueActors: number;
  firstSeen: string;
  lastSeen: string;
  maxRisk: number;
}

export interface RequestLogRow {
  requestId: string;
  createdAt: string;
  actorId: string;
  ipHash: string;
  /** Only populated within RAW_IP_RETENTION_DAYS of the request — null once redacted. */
  ipRaw: string | null;
  /** The literal HTTP Host header — a raw IP if the visitor addressed the box directly, or a
   * real hostname (e.g. www.mynewshop.io) if they came in through a domain. */
  host: string;
  /** True when `host` is a raw IP rather than a hostname — same check the honeypot itself runs
   * at capture time (DIRECT_IP_ACCESS event, packages/detection's matchesDirectIpAccess). */
  isDirectIp: boolean;
  method: string;
  path: string;
  queryString: string | null;
  statusCode: number;
  userAgentRaw: string | null;
  riskScore: number;
  endpoint: string;
  applicationComponent: string;
  /** From the actor's GeoIP enrichment — null unless GEOLOCATION_ENABLED is on. */
  country: string | null;
  region: string | null;
  city: string | null;
}

export interface ActorRow {
  actorId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  confidence: "low" | "medium" | "high";
  riskScore: number;
  totalRequests: number;
  uniquePaths: number;
  label: string | null;
  notes: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: string | null;
  organization: string | null;
}

export interface ActorProfile extends ActorRow {
  signals: Array<{ signalType: string; signalValue: string; firstSeenAt: string; lastSeenAt: string; occurrenceCount: number }>;
  sessionCount: number;
  ipCount: number;
  userAgentCount: number;
  canaryTriggerCount: number;
  authAttemptCount: number;
  enumerationEventCount: number;
  detections: DetectionRow[];
}

export interface TimelineEntry {
  at: string;
  kind: "request" | "event";
  label: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  eventType: string | null;
  severity: string | null;
  requestId: string | null;
  eventId: string | null;
}

export interface DetectionRow {
  detectionId: string;
  actorId: string;
  detectionType: string;
  confidence: string;
  evidence: Record<string, unknown>;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface CanaryRow {
  canaryId: string;
  canaryType: string;
  value: string;
  plantedLocation: string;
  createdAt: string;
  active: boolean;
  triggerCount: number;
}

export interface GeographyResponse {
  byCountry: Array<{ country: string; actorCount: number; requestCount: number; avgRisk: number; maxRisk: number }>;
  byAsn: Array<{ asn: string; organization: string | null; actorCount: number; requestCount: number; avgRisk: number; maxRisk: number }>;
  enrichmentActive: boolean;
}

export interface HeatmapPointRow {
  lat: number;
  lng: number;
  country: string | null;
  city: string | null;
  requestCount: number;
  maxRisk: number;
}

export interface FirstContactRow {
  actorId: string;
  firstSeenAt: string;
  firstSuspiciousAt: string | null;
  firstEnumerationAt: string | null;
  firstAuthAttemptAt: string | null;
  firstApiProbeAt: string | null;
  firstCanaryTriggerAt: string | null;
  lastSeenAt: string;
  secondsToFirstSuspicious: number | null;
  secondsToFirstCanary: number | null;
}

export interface DiscoveryFunnelResponse {
  stages: Array<{ stage: string; label: string; actorCount: number }>;
}

export interface VulnerabilityRow {
  vulnerability: string;
  category: string;
  endpoint: string;
  firstAttemptAt: string | null;
  firstConfirmedAt: string | null;
  actors: number;
  attempts: number;
  confirmed: number;
  dataExtractionEvents: number;
  canaryEvents: number;
}

export interface OverviewResponse {
  range: { since: string; until: string };
  totals: { totalRequests: number; uniqueActors: number; uniqueIps: number; uniqueUserAgents: number; errorCount: number };
  methodBreakdown: Array<{ method: string; count: number }>;
  topEndpoints: Array<{ path: string; count: number }>;
  eventTypeCounts: Array<{ eventType: string; count: number }>;
  canaryTriggerCount: number;
  detectionCount: number;
}

export interface IngestionHealth {
  events_received_total: number;
  events_processed_total: number;
  events_dropped_total: number;
  events_failed_total: number;
  requests_total: number;
  queue_depth: number;
  queue_capacity: number;
  db_write_latency_ms_p50: number;
  db_write_latency_ms_p95: number;
  db_write_latency_ms_p99: number;
  last_successful_flush_at: string | null;
}

export { BASE as API_BASE };
