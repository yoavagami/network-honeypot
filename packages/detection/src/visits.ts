import type { AgentScore, RequestEvidence, VisitEvidence } from "./agentScore.js";

/**
 * What a "visit" is, in one place — used by the honeypot's scoring worker (which stores the
 * verdict in visit_scores), the admin API's visit detail page and the tests. Pure: rows in,
 * visits out. Loading the rows is packages/db/src/visitRows.ts.
 *
 * A visit is a browser session (hp_session cookie) split into segments when its lab label changes
 * or it goes quiet for 30 minutes — one Chrome profile carries a person's own browsing and an
 * in-browser agent's runs. Clients that drop cookies get a new session per request, so
 * single-request sessions with no browser beacon are folded into one visit per actor per 30
 * minutes of activity.
 *
 * Visit ids: `s_<sessionId>_<firstRequestMs>` for session segments, `a_<actorId>_<firstRequestMs>`
 * for folded bursts. They are stable as long as the loaded window covers the visit's first request.
 */

export const VISIT_GAP_MS = 30 * 60_000;

export const PROBING_RE = /\.(env|git|aws|ssh|svn|htpasswd)\b|wp-(config|login|admin|json|content|includes)|phpinfo|xmlrpc|config\.(ya?ml|json|php)|credentials|backup|\.bak\b|docker-compose|server-status|\/\.well-known\/(?!security\.txt|http-message)/i;
export const ASSET_RE = /^\/(assets\/|favicon)/;
export const NON_PAGE_RE = /^\/(api\/|assets\/|favicon|robots\.txt|sitemap|\.well-known)/;
export const SHOP_STEPS = ["SHOP_PRODUCT_VIEW", "SHOP_ADD_TO_CART", "SHOP_CHECKOUT_START", "SHOP_CHECKOUT_DETAILS", "SHOP_CHECKOUT_SHIPPING", "SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"];
const CHECKOUT_STEPS = new Set(["SHOP_CHECKOUT_START", "SHOP_CHECKOUT_DETAILS", "SHOP_CHECKOUT_SHIPPING", "SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"]);

/** requests ⋈ request_signals ⋈ actors, one row per request. */
export interface VisitRequestRow {
  request_id: string; created_at: Date; actor_id: string; session_id: string | null; method: string; path: string; query_string: string | null;
  status_code: number; user_agent_raw: string | null; ip: string | null; lab_label: string | null; lab_verified: boolean;
  identity_verdict: string; identity_agent: string | null;
  ua_library: string | null; ja4: string | null; h2_fp: string | null; wba_status: string; wba_signer: string | null; ip_tor: boolean;
  verdict_method: string | null; verdict_reasons: string[] | null; ai_app: string | null; browser_family: string | null; flags: string[] | null;
  asn: string | null; organization: string | null; country: string | null; city: string | null; accept_language: string | null;
  page_load_id: string | null;
}
/** client_signals rows (fp, behavior, ladder). `bound` is null for rows from before binding. */
export interface VisitClientRow {
  session_id: string | null; actor_id: string; kind: string; created_at: Date; path: string | null;
  lab_label: string | null; lab_verified: boolean; page_load_id: string | null; bound: boolean | null; data: Record<string, any>;
}
/** SHOP_* events. */
export interface VisitShopRow { session_id: string | null; actor_id: string; created_at: Date; event_type: string; request_id: string | null; shop: Record<string, any> | null }

export interface Visit {
  id: string;
  sessionId: string | null;
  actorId: string;
  requests: VisitRequestRow[];
  client: VisitClientRow[];
  shop: VisitShopRow[];
}

/** Groups rows (any order) into visits. */
export function buildVisits(requestRows: VisitRequestRow[], clientRows: VisitClientRow[], shopRows: VisitShopRow[]): Visit[] {
  const rows = [...requestRows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  // Sessions with more than one request or any browser beacon are real visits; the rest fold.
  const sessionCounts = new Map<string, number>();
  for (const r of rows) if (r.session_id) sessionCounts.set(r.session_id, (sessionCounts.get(r.session_id) ?? 0) + 1);
  const beaconSessions = new Set(clientRows.map((c) => c.session_id).filter(Boolean) as string[]);
  const visits = new Map<string, Visit>();
  const foldOpen = new Map<string, { key: string; lastMs: number }>();
  const sessionSegments = new Map<string, Array<{ key: string; startMs: number; lastMs: number; lab: string | null }>>();
  const requestToVisit = new Map<string, string>();
  for (const r of rows) {
    let key: string;
    const t = r.created_at.getTime();
    if (r.session_id && ((sessionCounts.get(r.session_id) ?? 0) > 1 || beaconSessions.has(r.session_id))) {
      const segs = sessionSegments.get(r.session_id) ?? [];
      const cur = segs[segs.length - 1];
      if (cur && cur.lab === r.lab_label && t - cur.lastMs <= VISIT_GAP_MS) {
        cur.lastMs = t;
        key = cur.key;
      } else {
        key = `s_${r.session_id}_${t}`;
        segs.push({ key, startMs: t, lastMs: t, lab: r.lab_label });
        sessionSegments.set(r.session_id, segs);
      }
    } else {
      const open = foldOpen.get(r.actor_id);
      if (open && t - open.lastMs <= VISIT_GAP_MS) {
        key = open.key;
        open.lastMs = t;
      } else {
        key = `a_${r.actor_id}_${t}`;
        foldOpen.set(r.actor_id, { key, lastMs: t });
      }
    }
    requestToVisit.set(r.request_id, key);
    let v = visits.get(key);
    if (!v) {
      v = { id: key, sessionId: key.startsWith("s_") ? r.session_id : null, actorId: r.actor_id, requests: [], client: [], shop: [] };
      visits.set(key, v);
    }
    v.requests.push(r);
  }
  // Beacons belong to the session's segment with the same label that was open when they arrived.
  const segmentAt = (sessionId: string | null, t: number, lab: string | null) => {
    const segs = sessionId ? sessionSegments.get(sessionId) : undefined;
    if (!segs) return undefined;
    const open = segs.filter((g) => g.startMs <= t + 5_000);
    return (open.filter((g) => g.lab === lab).pop() ?? open.pop() ?? segs[0])!.key;
  };
  for (const c of [...clientRows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
    const key = segmentAt(c.session_id, c.created_at.getTime(), c.lab_label);
    if (key) visits.get(key)!.client.push(c);
  }
  for (const e of [...shopRows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
    const key = (e.request_id ? requestToVisit.get(e.request_id) : undefined) ?? segmentAt(e.session_id, e.created_at.getTime(), null);
    if (key) visits.get(key)!.shop.push(e);
  }
  return [...visits.values()];
}

/** Beacons whose page-load id was checked and found not to belong to this visitor. */
const isUnbound = (c: VisitClientRow) => c.bound === false;

/** The scorer's input for one visit. Unbound beacons are counted, not used as evidence. */
export function visitEvidence(v: Visit, evaluatedAt: Date = new Date()): VisitEvidence {
  const first = v.requests[0]!;
  const trusted = v.client.filter((c) => !isUnbound(c));
  return {
    asn: first.asn,
    organization: first.organization,
    country: first.country,
    shopEvents: v.shop.map((e) => e.event_type),
    evaluatedAt: evaluatedAt.toISOString(),
    ladder: {
      served: v.requests.filter((r) => r.page_load_id).map((r) => ({ pl: r.page_load_id!, path: r.path, at: r.created_at.toISOString() })),
      // fp/behavior beacons carry the server's page-load id too, so they also prove JS ran.
      hits: trusted.flatMap((c) => {
        if (!c.page_load_id) return [];
        const rung = c.kind === "ladder" ? c.data?.rung : c.kind === "fp" || c.kind === "behavior" ? "js" : null;
        return rung === "css" || rung === "noscript" || rung === "js" ? [{ pl: c.page_load_id, rung, at: c.created_at.toISOString() }] : [];
      }),
    },
    client: {
      fingerprints: trusted.filter((c) => c.kind === "fp").map((c) => c.data),
      // `at` (server receive time) dates each page on one visit timeline (pageControl.ts, inputFacts).
      behaviors: trusted.filter((c) => c.kind === "behavior").map((c) => ({ ...c.data, pl: c.page_load_id, path: c.path, at: c.created_at.toISOString() })),
      unboundBeacons: v.client.filter((c) => isUnbound(c) && (c.kind === "fp" || c.kind === "behavior")).length,
    },
    requests: v.requests.map<RequestEvidence>((r) => ({
      at: r.created_at.toISOString(),
      method: r.method,
      path: r.path,
      status: r.status_code,
      verdict: r.identity_verdict,
      agent: r.identity_agent,
      verdictMethod: r.verdict_method,
      verdictReasons: r.verdict_reasons ?? [],
      uaLibrary: r.ua_library,
      aiApp: r.ai_app,
      browserFamily: r.browser_family,
      consistencyFlags: r.flags ?? [],
      tor: r.ip_tor,
      isHtmlPage: r.method === "GET" && r.status_code < 400 && !NON_PAGE_RE.test(r.path),
      isAsset: ASSET_RE.test(r.path),
      probing: PROBING_RE.test(r.path),
      userAgent: r.user_agent_raw,
      acceptLanguage: r.accept_language,
    })),
  };
}

export const mostCommon = <T,>(xs: T[]): T | null => {
  const counts = new Map<T, number>();
  for (const x of xs) if (x !== null && x !== undefined) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export interface ShopSummary {
  furthestStep: string | null;
  reachedCheckout: boolean;
  orderPlaced: boolean;
  orderTotalCents: number | null;
  paymentMethod: string | null;
  paymentDeclines: number;
}

export function shopSummary(v: Visit): ShopSummary | null {
  if (!v.shop.length) return null;
  const types = new Set(v.shop.map((e) => e.event_type));
  const furthest = [...SHOP_STEPS].reverse().find((s) => types.has(s)) ?? null;
  const order = v.shop.find((e) => e.event_type === "SHOP_ORDER_PLACED");
  return {
    furthestStep: furthest,
    reachedCheckout: furthest !== null && CHECKOUT_STEPS.has(furthest),
    orderPlaced: Boolean(order),
    orderTotalCents: order?.shop?.totals?.totalCents ?? null,
    paymentMethod: order?.shop?.method ?? v.shop.filter((e) => e.event_type === "SHOP_PAYMENT_ATTEMPT").at(-1)?.shop?.method ?? null,
    paymentDeclines: v.shop.filter((e) => e.event_type === "SHOP_PAYMENT_DECLINED").length,
  };
}

/** The list-row view of a scored visit (what the Agents list shows and visit_scores stores). */
export function visitSummary(v: Visit, score: AgentScore) {
  const first = v.requests[0]!;
  const last = v.requests[v.requests.length - 1]!;
  // Verified only if every labeled request/beacon of the visit came from a signed link.
  const labeled = [...v.requests.filter((r) => r.lab_label), ...v.client.filter((c) => c.lab_label)];
  const lab = mostCommon(v.requests.map((r) => r.lab_label)) ?? mostCommon(v.client.map((c) => c.lab_label));
  return {
    id: v.id,
    sessionId: v.sessionId,
    actorId: v.actorId,
    firstAt: first.created_at,
    lastAt: last.created_at,
    requestCount: v.requests.length,
    pageCount: v.requests.filter((r) => r.method === "GET" && !NON_PAGE_RE.test(r.path)).length,
    ip: mostCommon(v.requests.map((r) => r.ip)),
    network: first.organization,
    asn: first.asn,
    country: first.country,
    userAgent: mostCommon(v.requests.map((r) => r.user_agent_raw)),
    lab,
    labVerified: lab !== null && labeled.length > 0 && labeled.every((x) => x.lab_verified),
    ja4: mostCommon(v.requests.map((r) => r.ja4)),
    hasBrowserBeacon: v.client.length > 0,
    unboundBeacons: v.client.filter(isUnbound).length,
    shop: shopSummary(v),
    score,
  };
}
export type VisitSummary = ReturnType<typeof visitSummary>;
