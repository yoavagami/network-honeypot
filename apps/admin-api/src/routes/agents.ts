import type { FastifyInstance } from "fastify";
import { buildVisits, scoreVisit, signalCatalogue, visitEvidence, visitSummary, VISIT_GAP_MS, type Visit } from "@honeypot/detection";
import { loadVisitRows } from "@honeypot/db";
import { client } from "../db.js";
import { audit } from "../audit.js";
import { rangeHours, toVisitListRow, whyMatcher, type StoredVisitRow } from "../agentsQuery.js";

/**
 * Agents page API — "was each visit / request an AI agent, how sure, and why".
 *
 * Lists read visit_scores, written by the honeypot's scoring worker
 * (apps/honeypot/src/scoring/visitScorer.ts) as visits happen — an indexed query instead of
 * rescoring every request per page view. The visit detail page still scores on read (one visit
 * is cheap, and it always reflects the current weights). What a "visit" is lives in
 * packages/detection/src/visits.ts; the rows come from packages/db/src/visitRows.ts.
 */

/** Most rows a list query returns before the "why" filter (which runs on the fetched rows). */
const LIST_CAP = 5_000;

function listFilters(q: Record<string, string | undefined>, since: Date) {
  const parts = [client`last_at >= ${since.toISOString()}::timestamptz`];
  if (q.bucket) parts.push(client`bucket = ${q.bucket}`);
  if (q.type) parts.push(client`type = ${q.type}`);
  if (q.lab === "only") parts.push(client`lab_label IS NOT NULL`);
  else if (q.lab === "verified") parts.push(client`lab_verified`);
  else if (q.lab) parts.push(client`lab_label = ${q.lab}`);
  if (q.shop === "checkout") parts.push(client`(summary #>> '{shop,reachedCheckout}')::boolean IS TRUE`);
  else if (q.shop === "any") parts.push(client`jsonb_typeof(summary -> 'shop') = 'object'`);
  // Who drove the visit (pageControl.ts): hybrid = control changed hands.
  if (q.control === "hybrid") parts.push(client`summary #>> '{control,mode}' IN ('agent_then_human', 'human_then_agent', 'mixed')`);
  else if (q.control) parts.push(client`summary #>> '{control,mode}' = ${q.control}`);
  if (q.q) {
    const like = `%${q.q.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    parts.push(client`(host(ip) ILIKE ${like} OR summary ->> 'userAgent' ILIKE ${like} OR summary ->> 'network' ILIKE ${like}
      OR lab_label ILIKE ${like} OR agent ILIKE ${like} OR visit_id ILIKE ${like})`);
  }
  return parts.reduce((acc, p, i) => (i === 0 ? p : client`${acc} AND ${p}`));
}

/** Rebuilds one visit from its rows (for the detail page and request lookups). */
async function loadVisit(id: string): Promise<Visit | null> {
  const [stored] = await client<Array<{ session_id: string | null; actor_id: string; first_at: Date; last_at: Date }>>`
    SELECT session_id, actor_id, first_at, last_at FROM visit_scores WHERE visit_id = ${id}`;
  let rows;
  if (stored) {
    // Load exactly the visit's window (plus the gap, for requests that arrived after scoring).
    const since = new Date(new Date(stored.first_at).getTime() - 1_000);
    const until = new Date(new Date(stored.last_at).getTime() + VISIT_GAP_MS);
    rows = await loadVisitRows(client, stored.session_id ? { since, until, sessionId: stored.session_id } : { since, until, actorIds: [stored.actor_id] });
  } else {
    // Not scored yet (or from before visit_scores existed): fall back to the id's own session/actor.
    const m = /^([sa])_([0-9a-f-]{36})_(\d+)$/.exec(id);
    if (!m) return null;
    const start = Number(m[3]);
    const since = new Date(start - 1_000);
    const until = new Date(start + 24 * 3600_000);
    rows = await loadVisitRows(client, m[1] === "s" ? { since, until, sessionId: m[2]! } : { since, until, actorIds: [m[2]!] });
  }
  const visits = buildVisits(rows.requests, rows.client, rows.shop);
  return visits.find((x) => x.id === id) ?? null;
}

export function registerAgentRoutes(app: FastifyInstance) {
  app.get("/api/agents/visits", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const since = new Date(Date.now() - rangeHours(q.range, "7d") * 3600_000);
    const where = listFilters(q, since);
    const rows = await client<StoredVisitRow[]>`
      SELECT visit_id, session_id, actor_id, first_at, last_at, request_count, page_count, lab_label, lab_verified, probability, bucket,
             type, agent, proven, reasons, host(ip) AS ip, summary, scorer_version, settled, computed_at
      FROM visit_scores WHERE ${where}
      ORDER BY last_at DESC
      LIMIT ${LIST_CAP}`;
    const why = whyMatcher(q.why, q.whyScope);
    const matched = why ? rows.filter((r) => why(r.reasons ?? [])) : rows;

    let total: number;
    const counts: Record<string, number> = { ai_agent: 0, probably_ai_agent: 0, not_sure: 0, not_ai_agent: 0 };
    const types: Record<string, number> = {};
    if (why) {
      // The why filter runs on the fetched rows, so counts come from them too.
      total = matched.length;
      for (const r of matched) {
        counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
        types[r.type] = (types[r.type] ?? 0) + 1;
      }
    } else {
      const agg = await client<Array<{ bucket: string; type: string; n: number }>>`
        SELECT bucket, type, count(*)::int AS n FROM visit_scores WHERE ${where} GROUP BY bucket, type`;
      total = 0;
      for (const a of agg) {
        total += a.n;
        counts[a.bucket] = (counts[a.bucket] ?? 0) + a.n;
        types[a.type] = (types[a.type] ?? 0) + a.n;
      }
    }
    const [lag] = await client<Array<{ last: Date | null }>>`SELECT max(computed_at) AS last FROM visit_scores`;
    const limit = Math.min(1000, Number(q.limit ?? 300));
    await audit(request.adminSession!.adminUserId, "list_agent_visits", null, null, { count: total });
    return {
      data: matched.slice(0, limit).map((r) => toVisitListRow(r)),
      total,
      counts,
      types,
      // true when the why filter only saw the newest LIST_CAP visits of the range
      truncated: Boolean(why) && rows.length >= LIST_CAP,
      lastScoredAt: lag?.last ?? null,
    };
  });

  app.get("/api/agents/requests", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const since = new Date(Date.now() - rangeHours(q.range, "24h") * 3600_000).toISOString();
    const limit = Math.min(2000, Number(q.limit ?? 500));
    const bucket = q.bucket ? client`AND v.bucket = ${q.bucket}` : client``;
    const assets = q.all === "1" ? client`` : client`AND r.path <> '/api/v1/rum' AND r.path !~ '^/(assets/|favicon)'`;
    const rows = await client<Array<{
      request_id: string; created_at: Date; method: string; path: string; status_code: number; ip: string | null; user_agent_raw: string | null;
      lab_label: string | null; visit_id: string; identity_verdict: string; identity_agent: string | null;
      probability: number; bucket: string; type: string; agent: string | null; reasons: StoredVisitRow["reasons"];
    }>>`
      SELECT r.request_id, r.created_at, r.method, r.path, r.status_code, host(r.ip_raw) AS ip, r.user_agent_raw, s.lab_label,
             vr.visit_id, s.identity_verdict, s.identity_agent, v.probability, v.bucket, v.type, v.agent, v.reasons
      FROM requests r
      JOIN request_signals s USING (request_id)
      JOIN visit_requests vr ON vr.request_id = r.request_id
      JOIN visit_scores v ON v.visit_id = vr.visit_id
      WHERE r.created_at >= ${since}::timestamptz ${bucket} ${assets}
      ORDER BY r.created_at DESC
      LIMIT ${LIST_CAP}`;
    const why = whyMatcher(q.why, q.whyScope);
    const out = (why ? rows.filter((r) => why(r.reasons ?? [])) : rows).map((r) => ({
      requestId: r.request_id, at: new Date(r.created_at), method: r.method, path: r.path, status: r.status_code, ip: r.ip,
      userAgent: r.user_agent_raw, lab: r.lab_label, visitId: r.visit_id, requestVerdict: r.identity_verdict, requestAgent: r.identity_agent,
      probability: r.probability, bucket: r.bucket, type: r.type, agent: r.agent, topReason: r.reasons?.[0]?.text ?? null,
    }));
    await audit(request.adminSession!.adminUserId, "list_agent_requests", null, null, { count: out.length });
    return { data: out.slice(0, limit), total: out.length };
  });

  app.get<{ Params: { id: string } }>("/api/agents/visits/:id", async (request, reply) => {
    const id = request.params.id;
    if (!/^[sa]_[0-9a-f-]{36}_\d+$/.test(id)) return reply.status(400).send({ error: { code: "bad_id", message: "unknown visit id" } });
    const v = await loadVisit(id);
    if (!v) return reply.status(404).send({ error: { code: "not_found", message: "visit not found" } });
    const score = scoreVisit(visitEvidence(v));
    const fp = v.client.find((c) => c.kind === "fp" && c.bound !== false)?.data ?? null;
    const behavior = v.client.filter((c) => c.kind === "behavior").map((c) => ({ at: c.created_at, path: c.path, bound: c.bound, ...c.data }));
    const first = v.requests[0]!;
    const summary = visitSummary(v, score);
    await audit(request.adminSession!.adminUserId, "view_agent_visit", id, null, {});
    return {
      ...summary,
      network: {
        ip: summary.ip, asn: first.asn, organization: first.organization, country: first.country, city: first.city,
        ja4: [...new Set(v.requests.map((r) => r.ja4).filter(Boolean))], h2: [...new Set(v.requests.map((r) => r.h2_fp).filter(Boolean))],
        webBotAuth: [...new Set(v.requests.map((r) => (r.wba_status === "absent" ? null : `${r.wba_status}${r.wba_signer ? ` · ${r.wba_signer}` : ""}`)).filter(Boolean))],
        userAgents: [...new Set(v.requests.map((r) => r.user_agent_raw).filter(Boolean))],
      },
      requests: v.requests.map((r) => ({
        requestId: r.request_id, at: r.created_at, method: r.method, path: r.path, query: r.query_string, status: r.status_code,
        verdict: r.identity_verdict, agent: r.identity_agent, reason: r.verdict_reasons?.[0] ?? null, flags: r.flags ?? [],
      })),
      fingerprint: fp,
      pageLoads: v.client.filter((c) => c.kind === "fp").length,
      behavior,
      shopEvents: v.shop.map((e) => ({ at: e.created_at, type: e.event_type, requestId: e.request_id, detail: e.shop })),
    };
  });

  /** Which visit a request belongs to — for the agent panel on request/event detail pages. */
  app.get<{ Params: { requestId: string } }>("/api/agents/by-request/:requestId", async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(request.params.requestId)) return reply.status(400).send({ error: { code: "bad_id", message: "bad request id" } });
    const [row] = await client<Array<{ visit_id: string }>>`SELECT visit_id FROM visit_requests WHERE request_id = ${request.params.requestId}`;
    if (!row) return reply.status(404).send({ error: { code: "not_found", message: "this request hasn't been scored (captured before agent sensing went live, or the scorer hasn't run yet)" } });
    const v = await loadVisit(row.visit_id);
    if (!v) return reply.status(404).send({ error: { code: "not_found", message: "visit not found" } });
    const s = scoreVisit(visitEvidence(v));
    return { visitId: v.id, probability: s.probability, bucket: s.bucket, type: s.type, agent: s.agent, proven: s.proven, reasons: s.reasons };
  });

  /** Every scoring signal (packages/detection/src/signals.ts) and how often it fired in the range. */
  app.get("/api/agents/signals", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const since = new Date(Date.now() - rangeHours(q.range, "7d") * 3600_000).toISOString();
    const fired = await client<Array<{ signal: string; visits: number; lab_visits: number; human_lab_visits: number }>>`
      SELECT sig AS signal, count(*)::int AS visits,
             count(*) FILTER (WHERE lab_verified)::int AS lab_visits,
             count(*) FILTER (WHERE lab_verified AND lab_label LIKE 'human-%')::int AS human_lab_visits
      FROM visit_scores, unnest(signals) AS sig
      WHERE last_at >= ${since}::timestamptz
      GROUP BY sig`;
    const [tot] = await client<Array<{ n: number }>>`SELECT count(*)::int AS n FROM visit_scores WHERE last_at >= ${since}::timestamptz`;
    const bySignal = new Map(fired.map((f) => [f.signal, f]));
    return {
      totalVisits: tot?.n ?? 0,
      data: signalCatalogue().map((s) => ({ ...s, visits: bySignal.get(s.id)?.visits ?? 0, labVisits: bySignal.get(s.id)?.lab_visits ?? 0, humanLabVisits: bySignal.get(s.id)?.human_lab_visits ?? 0 })),
    };
  });
}

