import { buildVisits, scoreVisit, visitEvidence, visitSummary, type AgentScore } from "@honeypot/detection";
import type { MerchantTx } from "@honeypot/merchant-db";
import type { Scope } from "./queries.js";
import { loadSessionEvents, LOOKBACK_MS } from "./scoring/load.js";
import { toVisitRows, type MerchantEventRow } from "./scoring/visits.js";
import { visitIdFor } from "./ids.js";

/**
 * One merchant visit in the same shape as the honeypot's Agents visit page (admin-api
 * GET /api/agents/visits/:id), so the dashboard renders both with the same panels.
 *
 *   audience "admin"    — everything, as for honeypot visits (raw fingerprint, weights, IP).
 *   audience "merchant" — the merchant's own dashboard: plain findings. No visitor IP, no raw
 *                          fingerprint dump, no signal weights or internal check details that
 *                          would show agent builders exactly what to patch.
 */
export type Audience = "admin" | "merchant";

/** Fingerprint fields the merchant view shows (the Browser panel), nothing else. */
function merchantFingerprint(fp: Record<string, any> | null) {
  if (!fp) return null;
  return {
    nav: { webdriver: fp.nav?.webdriver, languages: fp.nav?.languages, hardwareConcurrency: fp.nav?.hardwareConcurrency, deviceMemory: fp.nav?.deviceMemory },
    automation: { globals: fp.automation?.globals ?? [], cdpRuntime: fp.automation?.cdpRuntime },
    webgl: { supported: fp.webgl?.supported, renderer: fp.webgl?.renderer },
    screen: fp.screen,
    doc: { hasFocus: fp.doc?.hasFocus, visibility: fp.doc?.visibility },
    intl: { tz: fp.intl?.tz },
    uaData: fp.uaData?.fullVersionList ? { fullVersionList: fp.uaData.fullVersionList } : fp.uaData?.low ? { low: { brands: fp.uaData.low.brands } } : undefined,
    artifacts: (fp.artifacts ?? []).filter((a: any) => a?.known).map((a: any) => ({ tag: a.tag, id: a.id, cls: a.cls, known: a.known })),
  };
}

const BEHAVIOR_KEYS = ["mouseMoves", "mouseDistance", "keyDowns", "inputWithoutKey", "scrolls", "wheels", "visibility", "focus"];
function merchantBehavior(b: Record<string, any>) {
  const out: Record<string, any> = { at: b.at, path: b.path };
  const src = b.behavior ?? b;
  const beh: Record<string, any> = {};
  for (const k of BEHAVIOR_KEYS) if (src[k] !== undefined) beh[k] = src[k];
  beh.clicks = (src.clicks ?? []).slice(0, 20).map((c: any) => ({ target: c.target, trusted: c.trusted, movesLast1s: c.movesLast1s }));
  out.behavior = beh;
  out.visibility = b.visibility;
  out.focus = b.focus;
  out.artifacts = (b.artifacts ?? []).filter((a: any) => a?.known).map((a: any) => ({ tag: a.tag, id: a.id, cls: a.cls, known: a.known }));
  return out;
}

/** Signal weights become a direction only (+1 toward agent, −1 toward human). */
function merchantScore(s: AgentScore): AgentScore {
  return {
    ...s,
    reasons: s.reasons.map((r) => ({ ...r, weight: r.weight === 0 ? 0 : Math.sign(r.weight) })),
    ladder: { pages: [], summary: null },
  };
}

export async function buildVisitDetail(tx: MerchantTx, s: Scope, visitId: string, audience: Audience) {
  if (!/^vis_[A-Za-z0-9]{20}$/.test(visitId)) return null;
  const [row] = await tx`
    SELECT v.*, m.company FROM merchant_visits v JOIN merchants m USING (merchant_id)
    WHERE v.visit_id = ${visitId} AND v.livemode = ${s.livemode} ${s.merchantId ? tx`AND v.merchant_id = ${s.merchantId}` : tx``}`;
  if (!row) return null;
  const events: MerchantEventRow[] = await loadSessionEvents(tx, row.merchant_id, row.livemode, [row.session_id], new Date(new Date(row.first_at).getTime() - LOOKBACK_MS));
  const rows = toVisitRows(events);
  const v = buildVisits(rows.requests, rows.client, rows.shop).find((x) => visitIdFor(row.merchant_id, x.id) === visitId);
  if (!v) return null;
  const score = scoreVisit(visitEvidence(v, new Date()));
  const summary = visitSummary(v, score);
  const first = v.requests[0]!;
  const fp = v.client.find((c) => c.kind === "fp" && c.bound !== false)?.data ?? null;
  const behavior = v.client.filter((c) => c.kind === "behavior").map((c) => ({ at: c.created_at, path: c.path, bound: c.bound, ...c.data }));
  const firstMs = summary.firstAt.getTime();
  const lastMs = Math.max(summary.lastAt.getTime(), ...v.client.map((c) => c.created_at.getTime()), ...v.shop.map((e) => e.created_at.getTime()));
  const timeline = events
    .filter((e) => new Date(e.created_at).getTime() >= firstMs - 1000 && new Date(e.created_at).getTime() <= lastMs + 1000)
    .filter((e) => e.kind !== "fp" && e.kind !== "probe")
    .slice(0, 300)
    .map((e) => ({ kind: e.kind, name: e.name, path: e.path, at: e.created_at }));
  const assessments = await tx`
    SELECT assessment_id, order_id, amount, currency, response->>'suggested_action' AS suggested_action, response->>'driver' AS driver, final, created_at
    FROM assessments WHERE visit_id = ${visitId} ORDER BY created_at`;
  const admin = audience === "admin";

  return {
    // Same fields as the honeypot visit detail (apps/admin-web AgentVisitDetail)…
    id: visitId,
    sessionId: null,
    actorId: null,
    firstAt: summary.firstAt,
    lastAt: new Date(lastMs),
    requestCount: summary.requestCount,
    pageCount: summary.pageCount,
    lab: admin ? summary.lab : null,
    labVerified: admin ? summary.labVerified : false,
    unboundBeacons: summary.unboundBeacons,
    hasBrowserBeacon: summary.hasBrowserBeacon,
    score: admin ? score : merchantScore(score),
    network: {
      ip: admin ? summary.ip : null,
      asn: first.asn, organization: first.organization, country: first.country, city: null,
      ja4: [], h2: [],
      webBotAuth: [...new Set(v.requests.map((r) => (r.wba_status === "absent" ? null : `${r.wba_status}${r.wba_signer ? ` · ${r.wba_signer}` : ""}`)).filter(Boolean))],
      userAgents: [...new Set(v.requests.map((r) => r.user_agent_raw).filter(Boolean))],
    },
    requests: admin
      ? v.requests.map((r) => ({
          requestId: r.request_id, at: r.created_at, method: r.method, path: r.path, query: null, status: r.status_code,
          verdict: r.identity_verdict, agent: r.identity_agent, reason: r.verdict_reasons?.[0] ?? null, flags: r.flags ?? [],
        }))
      : [],
    fingerprint: admin ? fp : merchantFingerprint(fp),
    pageLoads: v.client.filter((c) => c.kind === "fp").length,
    behavior: admin ? behavior : behavior.map(merchantBehavior),
    shopEvents: v.shop.map((e) => ({ at: e.created_at, type: e.event_type, requestId: null, detail: e.event_type === "SHOP_ORDER_PLACED" ? e.shop : null })),
    // …plus what only merchant visits have.
    merchant: {
      visitId,
      merchantId: row.merchant_id,
      company: row.company,
      livemode: row.livemode,
      settled: row.settled,
      driver: row.driver,
      timeline,
      assessments,
    },
  };
}
