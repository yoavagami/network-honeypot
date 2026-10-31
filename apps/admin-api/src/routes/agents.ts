import type { FastifyInstance } from "fastify";
import { scoreVisit, type AgentScore, type RequestEvidence, type VisitEvidence } from "@honeypot/detection";
import { client } from "../db.js";
import { audit } from "../audit.js";

/**
 * Agents page API — "was each visit / request an AI agent, how sure, and why".
 *
 * A *visit* is a session (hp_session cookie). Clients that drop cookies get a new session per
 * request, so single-request sessions with no browser beacon are folded into one visit per
 * actor per 30 minutes of activity. Every visit is scored on read by
 * packages/detection/src/agentScore.ts over request_signals + client_signals + shop events, so
 * changing a weight re-scores all history with no migration. Only requests captured since agent
 * sensing went live (they have a request_signals row) are included.
 */

const RANGES: Record<string, number> = { "1h": 1, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };
const MAX_REQUESTS = 25_000;
const FOLD_GAP_MS = 30 * 60_000;
const PROBING_RE = /\.(env|git|aws|ssh|svn|htpasswd)\b|wp-(config|login|admin|json|content|includes)|phpinfo|xmlrpc|config\.(ya?ml|json|php)|credentials|backup|\.bak\b|docker-compose|server-status|\/\.well-known\/(?!security\.txt|http-message)/i;
const ASSET_RE = /^\/(assets\/|favicon)/;
const NON_PAGE_RE = /^\/(api\/|assets\/|favicon|robots\.txt|sitemap|\.well-known)/;
const SHOP_STEPS = ["SHOP_PRODUCT_VIEW", "SHOP_ADD_TO_CART", "SHOP_CHECKOUT_START", "SHOP_CHECKOUT_DETAILS", "SHOP_CHECKOUT_SHIPPING", "SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"];

interface ReqRow {
  request_id: string; created_at: Date; actor_id: string; session_id: string | null; method: string; path: string; query_string: string | null;
  status_code: number; user_agent_raw: string | null; ip: string | null; lab_label: string | null; identity_verdict: string; identity_agent: string | null;
  ua_library: string | null; ja4: string | null; h2_fp: string | null; wba_status: string; wba_signer: string | null; ip_tor: boolean;
  verdict_method: string | null; verdict_reasons: string[] | null; ai_app: string | null; browser_family: string | null; flags: string[] | null;
  asn: string | null; organization: string | null; country: string | null; city: string | null;
}
interface ClientRow { session_id: string | null; actor_id: string; kind: string; created_at: Date; path: string | null; lab_label: string | null; data: Record<string, any> }
interface ShopRow { session_id: string | null; actor_id: string; created_at: Date; event_type: string; request_id: string | null; shop: Record<string, any> | null }

interface Visit {
  id: string;
  sessionId: string | null;
  actorId: string;
  requests: ReqRow[];
  client: ClientRow[];
  shop: ShopRow[];
}

async function loadVisits(sinceHours: number, filter: { sessionId?: string; actorId?: string } = {}): Promise<{ visits: Visit[]; truncated: boolean }> {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const sessionFilter = filter.sessionId ? client`AND r.session_id = ${filter.sessionId}` : filter.actorId ? client`AND r.actor_id = ${filter.actorId}` : client``;
  const rows = await client<ReqRow[]>`
    SELECT r.request_id, r.created_at, r.actor_id, r.session_id, r.method, r.path, r.query_string, r.status_code, r.user_agent_raw,
           host(r.ip_raw) AS ip, s.lab_label, s.identity_verdict, s.identity_agent, s.ua_library, s.ja4, s.h2_fp, s.wba_status, s.wba_signer,
           s.ip_tor, s.data #>> '{identity,method}' AS verdict_method,
           ARRAY(SELECT jsonb_array_elements_text(coalesce(s.data #> '{identity,reasons}', '[]'))) AS verdict_reasons,
           s.data #>> '{ua,aiApp}' AS ai_app, s.data #>> '{ua,browser,family}' AS browser_family,
           ARRAY(SELECT jsonb_array_elements_text(coalesce(s.data -> 'consistencyFlags', '[]'))) AS flags,
           a.asn, a.organization, a.country, a.city
    FROM requests r
    JOIN request_signals s USING (request_id)
    LEFT JOIN actors a ON a.actor_id = r.actor_id
    WHERE r.created_at >= ${since}::timestamptz ${sessionFilter}
    ORDER BY r.created_at ASC
    LIMIT ${MAX_REQUESTS}`;
  // This client hands timestamps back as strings (see packages/db client config).
  for (const r of rows) r.created_at = new Date(r.created_at);
  const truncated = rows.length >= MAX_REQUESTS;
  const actorIds = [...new Set(rows.map((r) => r.actor_id))];
  const clientRows = actorIds.length
    ? await client<ClientRow[]>`
        SELECT session_id, actor_id, kind, created_at, path, lab_label,
               CASE WHEN kind = 'fp' THEN jsonb_build_object(
                 'nav', jsonb_build_object('webdriver', data #> '{nav,webdriver}', 'languages', data #> '{nav,languages}', 'platform', data #> '{nav,platform}', 'hardwareConcurrency', data #> '{nav,hardwareConcurrency}'),
                 'automation', data -> 'automation', 'webgl', data -> 'webgl', 'screen', data -> 'screen', 'doc', data -> 'doc',
                 'globalsDiff', data -> 'globalsDiff', 'artifacts', data -> 'artifacts', 'intl', data -> 'intl', 'timing', data -> 'timing',
                 'uaData', data -> 'uaData', 'canvas', data -> 'canvas', 'audio', data -> 'audio', 'fonts', data -> 'fonts')
               ELSE data END AS data
        FROM client_signals WHERE created_at >= ${since}::timestamptz AND actor_id = ANY(${actorIds}::uuid[]) ORDER BY created_at`
    : [];
  const shopRows = actorIds.length
    ? await client<ShopRow[]>`
        SELECT session_id, actor_id, created_at, event_type, request_id, metadata -> 'shop' AS shop
        FROM events WHERE created_at >= ${since}::timestamptz AND event_type LIKE 'SHOP\\_%' AND actor_id = ANY(${actorIds}::uuid[]) ORDER BY created_at`
    : [];

  for (const c of clientRows) c.created_at = new Date(c.created_at);
  for (const e of shopRows) e.created_at = new Date(e.created_at);
  // Sessions with more than one request or any browser beacon are real visits; the rest fold.
  const sessionCounts = new Map<string, number>();
  for (const r of rows) if (r.session_id) sessionCounts.set(r.session_id, (sessionCounts.get(r.session_id) ?? 0) + 1);
  const beaconSessions = new Set(clientRows.map((c) => c.session_id).filter(Boolean) as string[]);
  const visits = new Map<string, Visit>();
  const foldOpen = new Map<string, { key: string; lastMs: number }>();
  // A browser session splits into separate visits when its lab label changes or it goes quiet for
  // 30 minutes — one Chrome profile carries a person's browsing and an in-browser agent's runs.
  const sessionSegments = new Map<string, Array<{ key: string; startMs: number; lastMs: number; lab: string | null }>>();
  const requestToVisit = new Map<string, string>();
  for (const r of rows) {
    let key: string;
    const t = r.created_at.getTime();
    if (r.session_id && ((sessionCounts.get(r.session_id) ?? 0) > 1 || beaconSessions.has(r.session_id))) {
      const segs = sessionSegments.get(r.session_id) ?? [];
      const cur = segs[segs.length - 1];
      if (cur && cur.lab === r.lab_label && t - cur.lastMs <= FOLD_GAP_MS) {
        cur.lastMs = t;
        key = cur.key;
      } else {
        key = `s_${r.session_id}_${t}`;
        segs.push({ key, startMs: t, lastMs: t, lab: r.lab_label });
        sessionSegments.set(r.session_id, segs);
      }
    } else {
      const open = foldOpen.get(r.actor_id);
      if (open && t - open.lastMs <= FOLD_GAP_MS) {
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
  for (const c of clientRows) {
    const key = segmentAt(c.session_id, c.created_at.getTime(), c.lab_label);
    if (key) visits.get(key)!.client.push(c);
  }
  for (const e of shopRows) {
    const key = (e.request_id ? requestToVisit.get(e.request_id) : undefined) ?? segmentAt(e.session_id, e.created_at.getTime(), null);
    if (key) visits.get(key)!.shop.push(e);
  }
  return { visits: [...visits.values()], truncated };
}

function evidence(v: Visit): VisitEvidence {
  const first = v.requests[0]!;
  return {
    asn: first.asn,
    organization: first.organization,
    shopEvents: v.shop.map((e) => e.event_type),
    client: {
      fingerprints: v.client.filter((c) => c.kind === "fp").map((c) => c.data),
      behaviors: v.client.filter((c) => c.kind === "behavior").map((c) => c.data),
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
    })),
  };
}

const mostCommon = <T,>(xs: T[]): T | null => {
  const counts = new Map<T, number>();
  for (const x of xs) if (x !== null && x !== undefined) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

function shopSummary(v: Visit) {
  if (!v.shop.length) return null;
  const types = new Set(v.shop.map((e) => e.event_type));
  const furthest = [...SHOP_STEPS].reverse().find((s) => types.has(s)) ?? null;
  const order = v.shop.find((e) => e.event_type === "SHOP_ORDER_PLACED");
  return {
    furthestStep: furthest,
    orderPlaced: Boolean(order),
    orderTotalCents: order?.shop?.totals?.totalCents ?? null,
    paymentMethod: order?.shop?.method ?? v.shop.filter((e) => e.event_type === "SHOP_PAYMENT_ATTEMPT").at(-1)?.shop?.method ?? null,
    paymentDeclines: v.shop.filter((e) => e.event_type === "SHOP_PAYMENT_DECLINED").length,
  };
}

function summarize(v: Visit, score: AgentScore) {
  const first = v.requests[0]!;
  const last = v.requests[v.requests.length - 1]!;
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
    lab: mostCommon(v.requests.map((r) => r.lab_label)) ?? mostCommon(v.client.map((c) => c.lab_label)),
    ja4: mostCommon(v.requests.map((r) => r.ja4)),
    hasBrowserBeacon: v.client.length > 0,
    shop: shopSummary(v),
    score: { ...score, reasons: score.reasons },
  };
}

export function registerAgentRoutes(app: FastifyInstance) {
  app.get("/api/agents/visits", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const hours = RANGES[q.range ?? "7d"] ?? RANGES["7d"]!;
    const { visits, truncated } = await loadVisits(hours);
    let rows = visits.map((v) => summarize(v, scoreVisit(evidence(v))));
    if (q.bucket) rows = rows.filter((r) => r.score.bucket === q.bucket);
    if (q.type) rows = rows.filter((r) => r.score.type === q.type);
    if (q.lab === "only") rows = rows.filter((r) => r.lab);
    else if (q.lab) rows = rows.filter((r) => r.lab === q.lab);
    if (q.shop === "checkout") rows = rows.filter((r) => r.shop && ["SHOP_CHECKOUT_START", "SHOP_CHECKOUT_DETAILS", "SHOP_CHECKOUT_SHIPPING", "SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"].includes(r.shop.furthestStep ?? ""));
    if (q.shop === "any") rows = rows.filter((r) => r.shop);
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((r) => [r.ip, r.userAgent, r.network, r.lab, r.score.agent, r.id].some((x) => x?.toLowerCase().includes(needle)));
    }
    rows.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
    const counts = { ai_agent: 0, probably_ai_agent: 0, not_sure: 0, not_ai_agent: 0 } as Record<string, number>;
    const types: Record<string, number> = {};
    for (const r of rows) {
      counts[r.score.bucket] = (counts[r.score.bucket] ?? 0) + 1;
      types[r.score.type] = (types[r.score.type] ?? 0) + 1;
    }
    const limit = Math.min(1000, Number(q.limit ?? 300));
    await audit(request.adminSession!.adminUserId, "list_agent_visits", null, null, { count: rows.length });
    return {
      data: rows.slice(0, limit).map((r) => ({ ...r, score: { ...r.score, reasons: r.score.reasons.slice(0, 4) } })),
      total: rows.length,
      counts,
      types,
      truncated,
    };
  });

  app.get("/api/agents/requests", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const hours = RANGES[q.range ?? "24h"] ?? RANGES["24h"]!;
    const { visits } = await loadVisits(hours);
    const out = [];
    for (const v of visits) {
      const s = scoreVisit(evidence(v));
      if (q.bucket && s.bucket !== q.bucket) continue;
      for (const r of v.requests) {
        // Beacons and static assets drown the page requests; ?all=1 keeps them.
        if (q.all !== "1" && (r.path === "/api/v1/rum" || ASSET_RE.test(r.path))) continue;
        out.push({
          requestId: r.request_id, at: r.created_at, method: r.method, path: r.path, status: r.status_code, ip: r.ip,
          userAgent: r.user_agent_raw, lab: r.lab_label, visitId: v.id, requestVerdict: r.identity_verdict, requestAgent: r.identity_agent,
          probability: s.probability, bucket: s.bucket, type: s.type, agent: s.agent, topReason: s.reasons[0]?.text ?? null,
        });
      }
    }
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    await audit(request.adminSession!.adminUserId, "list_agent_requests", null, null, { count: out.length });
    return { data: out.slice(0, Math.min(2000, Number(q.limit ?? 500))), total: out.length };
  });

  app.get<{ Params: { id: string } }>("/api/agents/visits/:id", async (request, reply) => {
    const id = request.params.id;
    let loaded;
    if (id.startsWith("s_")) loaded = await loadVisits(24 * 90, { sessionId: id.slice(2).split("_")[0] });
    else if (id.startsWith("a_")) loaded = await loadVisits(24 * 90, { actorId: id.split("_")[1] });
    else return reply.status(400).send({ error: { code: "bad_id", message: "unknown visit id" } });
    const v = loaded.visits.find((x) => x.id === id) ?? (id.startsWith("s_") ? loaded.visits[0] : undefined);
    if (!v) return reply.status(404).send({ error: { code: "not_found", message: "visit not found" } });
    const score = scoreVisit(evidence(v));
    const fp = v.client.find((c) => c.kind === "fp")?.data ?? null;
    const behavior = v.client.filter((c) => c.kind === "behavior").map((c) => ({ at: c.created_at, path: c.path, ...c.data }));
    const first = v.requests[0]!;
    await audit(request.adminSession!.adminUserId, "view_agent_visit", id, null, {});
    return {
      ...summarize(v, score),
      network: {
        ip: mostCommon(v.requests.map((r) => r.ip)), asn: first.asn, organization: first.organization, country: first.country, city: first.city,
        ja4: [...new Set(v.requests.map((r) => r.ja4).filter(Boolean))], h2: [...new Set(v.requests.map((r) => r.h2_fp).filter(Boolean))],
        webBotAuth: [...new Set(v.requests.map((r) => (r.wba_status === "absent" ? null : `${r.wba_status}${r.wba_signer ? ` · ${r.wba_signer}` : ""}`)).filter(Boolean))],
        userAgents: [...new Set(v.requests.map((r) => r.user_agent_raw).filter(Boolean))],
      },
      requests: v.requests.map((r) => ({
        requestId: r.request_id, at: r.created_at, method: r.method, path: r.path, query: r.query_string, status: r.status_code,
        verdict: r.identity_verdict, agent: r.identity_agent, reason: r.verdict_reasons?.[0] ?? null, flags: r.flags ?? [],
      })),
      fingerprint: fp,
      behavior,
      shopEvents: v.shop.map((e) => ({ at: e.created_at, type: e.event_type, requestId: e.request_id, detail: e.shop })),
    };
  });

  /** Which visit a request belongs to — for the agent panel on request/event detail pages. */
  app.get<{ Params: { requestId: string } }>("/api/agents/by-request/:requestId", async (request, reply) => {
    const [row] = await client<Array<{ session_id: string | null; actor_id: string }>>`
      SELECT r.session_id, r.actor_id FROM requests r JOIN request_signals s USING (request_id) WHERE r.request_id = ${request.params.requestId}`;
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "no agent signals for this request (captured before agent sensing went live?)" } });
    const loaded = await loadVisits(24 * 90, row.session_id ? { sessionId: row.session_id } : { actorId: row.actor_id });
    const v = loaded.visits.find((x) => x.requests.some((r) => r.request_id === request.params.requestId));
    if (!v) return reply.status(404).send({ error: { code: "not_found", message: "visit not found" } });
    const s = scoreVisit(evidence(v));
    return { visitId: v.id, probability: s.probability, bucket: s.bucket, type: s.type, agent: s.agent, proven: s.proven, reasons: s.reasons };
  });
}
