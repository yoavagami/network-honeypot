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

export type AdminRole = "admin" | "superadmin";
export interface AuthUser {
  username: string;
  role: AdminRole;
}

export interface AccessLogResponse {
  available: boolean;
  range: string;
  viewerIp: string;
  totals: { requests: number; uniqueIps: number; loginsOk: number; loginsFailed: number };
  visitors: Array<{ ip: string; hits: number; loginsOk: number; loginsFailed: number; firstSeen: string; lastSeen: string; userAgent: string }>;
  logins: Array<{ time: string; ip: string; result: "success" | "wrong_password" | "rate_limited" | "other"; userAgent: string; username: string | null; role: string | null }>;
  accounts: Array<{ username: string; role: string | null; loginsOk: number; loginsFailed: number; lastLogin: string | null; lastIp: string | null; ips: string[] }>;
  recent: Array<{ time: string; ip: string; method: string; uri: string; status: number; userAgent: string }>;
}

export const api = {
  login: (username: string, password: string) => request<AuthUser>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<AuthUser>("/api/auth/me"),
  /** Superadmin only — the API answers 404 for anyone else (see admin-api routes/accessLog.ts). */
  accessLog: (range: string) => request<AccessLogResponse>(`/api/access-log?${new URLSearchParams({ range })}`),

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
  infraOrigin: (range: string) => request<{ data: InfraOriginRow[] }>(`/api/analytics/infra-origin?range=${range}`),
  uniqueIps: (range: string) => request<{ data: IpBreakdownRow[] }>(`/api/analytics/ips?range=${range}`),
  uniqueUserAgents: (range: string) => request<{ data: UserAgentBreakdownRow[] }>(`/api/analytics/user-agents?range=${range}`),
  firstContact: () => request<{ data: FirstContactRow[] }>("/api/analytics/first-contact"),
  discoveryFunnel: (range: string) => request<DiscoveryFunnelResponse>(`/api/analytics/discovery-funnel?range=${range}`),
  vulnerabilities: (range: string) => request<{ data: VulnerabilityRow[] }>(`/api/analytics/vulnerabilities?range=${range}`),

  search: (q: string) => request<{ data: RequestRow[]; query: string }>(`/api/search?q=${encodeURIComponent(q)}`),

  agentVisits: (params: Record<string, string> = {}) => request<AgentVisitsResponse>(`/api/agents/visits?${new URLSearchParams(params)}`),
  agentVisit: (id: string) => request<AgentVisitDetail>(`/api/agents/visits/${encodeURIComponent(id)}`),
  agentRequests: (params: Record<string, string> = {}) => request<{ data: AgentRequestRow[]; total: number }>(`/api/agents/requests?${new URLSearchParams(params)}`),
  agentByRequest: (requestId: string) => request<AgentRequestScore>(`/api/agents/by-request/${requestId}`),
  agentSignals: (range: string) => request<AgentSignalsResponse>(`/api/agents/signals?${new URLSearchParams({ range })}`),
  labRuns: () => request<LabRunsResponse>("/api/lab/runs"),
  createLabRun: (body: LabRunInput) => request<LabRunCreated>("/api/lab/runs", { method: "POST", body: JSON.stringify(body) }),

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
  /** Redacted, size-bounded body — null for GET requests, credential-bearing routes
   * (login/register/reset-password/admin-login), or if there was simply no body. */
  requestBody: Record<string, unknown> | null;
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
  infra: { category: string; confidence: "known" | "heuristic" | "none"; label: string };
}

export interface InfraOriginRow {
  category: string;
  label: string;
  actorCount: number;
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

// ---- Agents page (admin-api routes/agents.ts, scoring in packages/detection/src/agentScore.ts)
export type AgentBucket = "ai_agent" | "probably_ai_agent" | "not_sure" | "not_ai_agent";
export interface AgentReason { signal: string; group: string; question?: "identity" | "driver" | "environment" | "journey"; weight: number; text: string }
export interface AgentScore {
  probability: number;
  bucket: AgentBucket;
  type: string;
  agent: string | null;
  proven: boolean;
  leaning: "agent" | "human";
  reasons: AgentReason[];
  calibrated: boolean;
  /** packages/detection/src/signals.ts SCORER_VERSION that produced the score. */
  scorerVersion?: string;
  checks: AgentConsistencyCheck[];
  control: AgentControl;
  environment: { tells: string[]; utcTimezone: boolean };
  input: AgentInputFacts;
  ladder: AgentRenderingLadder;
}
export type AgentLadderRung = "pending" | "html_only" | "images_only" | "css_no_js" | "js_no_css" | "ran_js";
export interface AgentPageLadder { pl: string; path: string; at: string; css: boolean; noscript: boolean; js: boolean; settled: boolean; rung: AgentLadderRung }
export interface AgentRenderingLadder { pages: AgentPageLadder[]; summary: AgentLadderRung | null }
export type AgentControlMode = "agent" | "human" | "agent_then_human" | "human_then_agent" | "mixed" | "unknown";
export interface AgentPageControl { pl: string | null; path: string | null; at: string | null; driver: "agent" | "human" | "both" | "unknown"; agentSigns: string[]; humanSigns: string[] }
export interface AgentControl {
  mode: AgentControlMode;
  pages: AgentPageControl[];
  jumpClicks: number; scriptFilledFields: number; scriptFilledPages: number; inputlessScrollPages: number;
  handover: { at: string | null; path: string | null; from: "agent" | "human"; to: "agent" | "human" } | null;
  agentDriven: boolean;
}
export interface AgentConsistencyCheck { id: string; label: string; page: string | null; server: string | null; status: "match" | "mismatch" | "unknown" }
export interface AgentInputFacts {
  trustedClicks: number; centredClicks: number; clickSpread: number | null;
  printableKeys: number; correctionKeys: number; modifierKeys: number; pastes: number; keyDowns: number;
  clickGaps: number; thinkPauses: number; medianThinkPauseMs: number | null;
}
export interface AgentShopSummary { furthestStep: string | null; orderPlaced: boolean; orderTotalCents: number | null; paymentMethod: string | null; paymentDeclines: number }
export interface AgentVisitRow {
  id: string;
  sessionId: string | null;
  actorId: string;
  firstAt: string;
  lastAt: string;
  requestCount: number;
  pageCount: number;
  ip: string | null;
  network: string | null;
  asn: string | null;
  country: string | null;
  userAgent: string | null;
  lab: string | null;
  /** The lab label came from a signed link (ground truth), not a bare ?lab= anyone can type. */
  labVerified: boolean;
  ja4: string | null;
  hasBrowserBeacon: boolean;
  /** Page-script beacons for page loads this visitor was never served (left out of the score). */
  unboundBeacons: number;
  shop: AgentShopSummary | null;
  score: AgentListScore;
}
/** Stored list rows (visit_scores) carry the verdict, not the per-page detail. */
export type AgentListScore = Omit<AgentScore, "environment" | "input" | "ladder"> & { settled?: boolean; computedAt?: string };
export interface AgentVisitsResponse {
  data: AgentVisitRow[]; total: number; counts: Record<AgentBucket, number>; types: Record<string, number>;
  /** true when the "why" filter only saw the newest 5,000 visits of the range */
  truncated: boolean;
  /** When the scoring worker last stored a score (null: nothing scored yet). */
  lastScoredAt: string | null;
}
export interface AgentVisitDetail extends Omit<AgentVisitRow, "network" | "score"> {
  score: AgentScore;
  network: AgentNetwork;
  requests: Array<{ requestId: string; at: string; method: string; path: string; query: string | null; status: number; verdict: string; agent: string | null; reason: string | null; flags: string[] }>;
  fingerprint: Record<string, any> | null;
  /** Number of page loads the page script reported from. */
  pageLoads: number;
  behavior: Array<Record<string, any>>;
  shopEvents: Array<{ at: string; type: string; requestId: string | null; detail: Record<string, any> | null }>;
}
export interface AgentNetwork { ip: string | null; asn: string | null; organization: string | null; country: string | null; city: string | null; ja4: string[]; h2: string[]; webBotAuth: string[]; userAgents: string[] }
export interface AgentRequestRow {
  requestId: string; at: string; method: string; path: string; status: number; ip: string | null; userAgent: string | null; lab: string | null;
  visitId: string; requestVerdict: string; requestAgent: string | null; probability: number; bucket: AgentBucket; type: string; agent: string | null; topReason: string | null;
}
export interface AgentRequestScore { visitId: string; probability: number; bucket: AgentBucket; type: string; agent: string | null; proven: boolean; reasons: AgentReason[] }

// ---- Signal catalogue (admin-api /api/agents/signals, packages/detection/src/signals.ts)
export interface AgentSignal {
  id: string; group: string; question: "identity" | "driver" | "environment" | "journey"; weight: number; dynamic?: string;
  aiSpecific?: boolean; scriptOnly?: boolean; summary: string;
  /** Visits in the range where it fired / of them signed lab runs / of them human control runs. */
  visits: number; labVisits: number; humanLabVisits: number;
}
export interface AgentSignalsResponse { totalVisits: number; data: AgentSignal[] }

// ---- Lab runs (admin-api routes/lab.ts)
export interface LabRunInput { label: string; kind: "agent" | "human"; agent?: string; scenario?: string; notes?: string; ttlDays?: number }
export interface LabRunCreated { label: string; kind: "agent" | "human"; expiresAt: string; query: string; url: string | null }
export interface LabRun {
  label: string; kind: "agent" | "human"; agent: string | null; scenario: string | null; notes: string | null;
  createdAt: string; expiresAt: string; createdBy: string | null;
  visits: number; lastSeen: string | null; buckets: Partial<Record<AgentBucket, number>>; proven: number;
  /** Agents the score named in this run's visits (empty: caught or cleared without a name). */
  detectedAgents: string[];
}
export interface LabRunsResponse { enabled: boolean; data: LabRun[] }
