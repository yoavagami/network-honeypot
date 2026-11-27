import { ApiError, request, type AgentBucket, type AgentVisitDetail } from "./api.js";

/**
 * Two clients for the merchant platform:
 *  - adminMerchants: the honeypot admin's view (admin-api /api/merchants, /api/merchant-data) —
 *    every merchant, filterable by one.
 *  - merchant: the merchant portal (/m/*), signed in as a merchant user against merchant-api's
 *    /m/api. Only ever that merchant's data.
 */
declare global {
  interface Window { __ADMIN_API_URL__?: string; __MERCHANT_API_URL__?: string }
}

const qs = (p: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export type Mode = "test" | "live";

export interface MerchantRow {
  merchant_id: string; status: string; company: string; website: string; contact_email: string; platform: string; monthly_checkouts: string | null;
  created_at: string; reviewed_at: string | null; reviewed_by: string | null; users: number; verified_domains: number; visits_7d: number; assessments_7d: number; last_event_at: string | null;
}
export interface VisitRow {
  visit_id: string; merchant_id: string; company: string; first_at: string; last_at: string; settled: boolean; probability: number; bucket: AgentBucket; type: string;
  checks_failed: number; checks_compared: number; lab_label?: string | null; lab_verified?: boolean;
  agent: string | null; proven: boolean; driver: string; handover: { page: string | null; at: string | null } | null; page_count: number;
  reached_checkout: boolean; reached_pay: boolean; network: { asn: string | null; organization: string | null; country: string | null } | null;
  user_agent: string | null; paths: string[] | null; assessments: number;
}
export interface OrderRow {
  assessment_id: string; merchant_id: string; company: string; order_id: string; amount: number; currency: string; visit_id: string | null; final: boolean;
  token_status: string; created_at: string; driver: string; decision: string | null; score: number; agent: { id: string; operator: string | null; verified: boolean } | null; outcome: string | null;
}
export interface Overview {
  days: number;
  totals: { visits: number; agent_visits: number; verified_agent_visits: number; checkouts: number; agent_checkouts: number; agent_share: number };
  drivers: Array<{ driver: string; visits: number }>;
  agents: Array<{ agent: string; verified: boolean; visits: number }>;
  funnel: Array<{ driver: string; visits: number; reached_checkout: number; reached_pay: number; assessed: number }>;
  daily: Array<{ day: string; visits: number; agent_visits: number }>;
  orders: { assessed: number; confirm: number; block: number };
}
export interface OrderDetail {
  assessment_id: string; merchant_id: string; company: string; visit_id: string | null; token_status: string; header_count: number; server_ms: number; final: boolean; created_at: string;
  response: Record<string, any>; feedback: Array<{ outcome: string; note: string | null; created_at: string }>;
}
export interface StatusCheck { id: string; status: "pass" | "fail" | "pending" | "not_applicable"; detail: string; checked_at: string }
export interface IntegrationStatus { merchant_id: string; livemode: boolean; all_passed: boolean; checks: StatusCheck[]; recent_events: Array<{ type: string; at: string; origin: string | null }> }

export interface PageHits {
  days: number;
  by_page: Array<{ path: string; hits: number; visitors: number; last_at: string }>;
  by_country: Array<{ country: string; hits: number }>;
  agents: Array<{ agent: string; hits: number; last_at: string }>;
  hits: Array<{ created_at: string; path: string; status: number; ip: string | null; country: string | null; network: string | null; user_agent: string | null; referrer: string | null; agent: string | null }>;
}

export interface SiteAlert {
  id: string; created_at: string; kind: "agent_file" | "developer_guide" | "access_request"; path: string; ip: string | null; country: string | null;
  network: string | null; user_agent: string | null; agent: string | null; company: string | null; delivered_at: string | null; delivery_error: string | null;
}

export const adminMerchants = {
  siteAlerts: () => request<{ alerts: SiteAlert[]; push_configured: boolean }>(`/api/merchant-site/alerts`),
  siteAlertCount: (since?: string) => request<{ new_count: number; last_at: string | null }>(`/api/merchant-site/alerts/count${qs({ since })}`),
  pageHits: (p: { days?: number; path?: string }) => request<PageHits>(`/api/merchant-site/hits${qs(p)}`),
  list: (status?: string) => request<{ merchants: MerchantRow[] }>(`/api/merchants${qs({ status })}`),
  get: (id: string) => request<Record<string, any>>(`/api/merchants/${id}`),
  approve: (id: string) => request<{ merchant_id: string; invite_url: string; invite_email: string }>(`/api/merchants/${id}/approve`, { method: "POST", body: "{}" }),
  decline: (id: string) => request<{ ok: true }>(`/api/merchants/${id}/decline`, { method: "POST", body: "{}" }),
  setStatus: (id: string, status: "approved" | "suspended") => request<{ ok: true }>(`/api/merchants/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  invite: (id: string, email?: string, role = "owner") => request<{ invite_url: string; invite_email: string }>(`/api/merchants/${id}/invite`, { method: "POST", body: JSON.stringify({ email: email || undefined, role }) }),
  overview: (p: { merchant_id?: string; mode: Mode; days?: number }) => request<Overview>(`/api/merchant-data/overview${qs(p)}`),
  visits: (p: { merchant_id?: string; mode: Mode; driver?: string; agents?: string; bucket?: string; lab?: string }) => request<{ visits: VisitRow[] }>(`/api/merchant-data/visits${qs(p)}`),
  visit: (id: string, mode: Mode) => request<AgentVisitDetail>(`/api/merchant-data/visits/${id}${qs({ mode })}`),
  orders: (p: { merchant_id?: string; mode: Mode; decision?: string }) => request<{ orders: OrderRow[] }>(`/api/merchant-data/orders${qs(p)}`),
  order: (id: string, mode: Mode) => request<OrderDetail>(`/api/merchant-data/orders/${id}${qs({ mode })}`),
};

// ------------------------------------------------------------------ merchant portal client

const runtimeAdmin = typeof window !== "undefined" ? window.__ADMIN_API_URL__ : undefined;
const runtimeMerchant = typeof window !== "undefined" ? window.__MERCHANT_API_URL__ : undefined;
/** Same origin in production (admin-web's nginx proxies /m/api); merchant-api's port in local dev. */
const MBASE = runtimeMerchant !== undefined ? runtimeMerchant : runtimeAdmin === "" ? "" : "http://localhost:8095";

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

async function mreq<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET") {
    const csrf = readCookie("uh_mcsrf");
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${MBASE}${path}`, { ...init, method, headers, credentials: "include" });
  if (!res.ok) {
    let code = "unknown_error";
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export interface MerchantMe { user: { email: string; name: string; role: "owner" | "developer" | "analyst" }; merchant: { id: string; company: string }; csrf: string; live_available: boolean }
export interface KeyRow { key_id: string; kind: "public" | "secret"; livemode: boolean; public_value: string | null; display: string; created_at: string; created_by: string; last_used_at: string | null; revoked_at: string | null }
export interface DomainRow { domain_id: string; host: string; verification_token: string; verified_at: string | null; verified_method: string | null; last_checked_at: string | null; txt_record: string; meta_tag: string }
export type Decision = "allow" | "confirm" | "block";
export type PolicyCategory = "spoofed_agent" | "verified_agent" | "unverified_agent" | "agent_then_human" | "uncertain";
export type Policy = Record<PolicyCategory, Decision>;

export const merchant = {
  login: (email: string, password: string) => mreq<{ ok: true }>("/m/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => mreq<{ ok: true }>("/m/api/auth/logout", { method: "POST", body: "{}" }),
  me: () => mreq<MerchantMe>("/m/api/auth/me"),
  invite: (token: string) => mreq<{ company: string; email: string; role: string; expires_at: string }>(`/m/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, name: string, password: string) => mreq<{ ok: true }>(`/m/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST", body: JSON.stringify({ name, password, accept_terms: true }) }),
  overview: (mode: Mode, days = 7) => mreq<Overview>(`/m/api/overview${qs({ mode, days })}`),
  visits: (p: { mode: Mode; driver?: string; agents?: string; bucket?: string }) => mreq<{ visits: VisitRow[] }>(`/m/api/visits${qs(p)}`),
  visit: (id: string, mode: Mode) => mreq<AgentVisitDetail>(`/m/api/visits/${id}${qs({ mode })}`),
  orders: (p: { mode: Mode; decision?: string }) => mreq<{ orders: OrderRow[] }>(`/m/api/orders${qs(p)}`),
  order: (id: string, mode: Mode) => mreq<OrderDetail>(`/m/api/orders/${id}${qs({ mode })}`),
  live: (mode: Mode) => mreq<{ visits: VisitRow[]; pay_events: Array<{ session_id: string; name: string | null; path: string | null; created_at: string; visit_id: string | null }>; at: string }>(`/m/api/live${qs({ mode })}`),
  integration: (mode: Mode) => mreq<IntegrationStatus>(`/m/api/integration${qs({ mode })}`),
  keys: () => mreq<{ keys: KeyRow[]; tag_base_url: string; api_url: string; merchant_id: string }>("/m/api/keys"),
  createKey: (kind: "public" | "secret", mode: Mode) => mreq<{ key_id: string; value: string; shown_once: boolean }>("/m/api/keys", { method: "POST", body: JSON.stringify({ kind, mode }) }),
  revokeKey: (id: string) => mreq<{ ok: true }>(`/m/api/keys/${id}/revoke`, { method: "POST", body: "{}" }),
  domains: () => mreq<{ domains: DomainRow[] }>("/m/api/domains"),
  addDomain: (host: string) => mreq<DomainRow>("/m/api/domains", { method: "POST", body: JSON.stringify({ host }) }),
  verifyDomain: (id: string) => mreq<{ verified: boolean; method?: string | null; error?: string }>(`/m/api/domains/${id}/verify`, { method: "POST", body: "{}" }),
  removeDomain: (id: string) => mreq<{ ok: true }>(`/m/api/domains/${id}`, { method: "DELETE" }),
  team: () => mreq<{ users: Array<{ user_id: string; email: string; name: string; role: string; disabled: boolean; last_login_at: string | null }>; invites: Array<{ email: string; role: string; expires_at: string }> }>("/m/api/team"),
  inviteUser: (email: string, role: string) => mreq<{ invite_url: string }>("/m/api/team/invites", { method: "POST", body: JSON.stringify({ email, role }) }),
  updateUser: (id: string, change: { role?: string; disabled?: boolean }) => mreq<{ ok: true }>(`/m/api/team/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
  webhooks: (mode: Mode) => mreq<{ endpoints: Array<{ endpoint_id: string; url: string; secret_display: string; events: string[]; created_at: string }>; deliveries: Array<{ event_id: string; type: string; status: string; attempts: number; last_status: number | null; last_error: string | null; is_test: boolean; created_at: string }> }>(`/m/api/webhooks${qs({ mode })}`),
  addWebhook: (url: string, mode: Mode) => mreq<{ endpoint_id: string; secret: string }>("/m/api/webhooks", { method: "POST", body: JSON.stringify({ url, mode }) }),
  removeWebhook: (id: string) => mreq<{ ok: true }>(`/m/api/webhooks/${id}`, { method: "DELETE" }),
  testWebhook: (id: string) => mreq<{ event_id: string }>(`/m/api/webhooks/${id}/test`, { method: "POST", body: "{}" }),
  policy: () => mreq<{ policy: Policy; default: Policy }>("/m/api/policy"),
  savePolicy: (p: Policy) => mreq<{ policy: Policy }>("/m/api/policy", { method: "PUT", body: JSON.stringify(p) }),
};
