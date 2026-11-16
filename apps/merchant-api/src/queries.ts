import type { MerchantTx } from "@honeypot/merchant-db";

/**
 * Dashboard read queries, shared by the merchant dashboard (/m/api, scoped to the signed-in
 * merchant — RLS limits merchant_app to it anyway) and the internal admin API (/internal, all
 * merchants or one, via merchant_admin). `merchantId: null` = every merchant.
 */
export interface Scope { merchantId: string | null; livemode: boolean }

const AGENT_DRIVERS = ["agent", "agent_then_human", "human_then_agent", "mixed"];

const merchantFilter = (tx: MerchantTx, s: Scope, col = "merchant_id") => (s.merchantId ? tx`AND ${tx(col)} = ${s.merchantId}` : tx``);

export async function overview(tx: MerchantTx, s: Scope, days: number) {
  const since = new Date(Date.now() - days * 86400_000);
  const mf = merchantFilter(tx, s);
  const [totals] = await tx<{ visits: number; agent_visits: number; verified_agent_visits: number; checkouts: number; agent_checkouts: number }[]>`
    SELECT count(*)::int AS visits,
           count(*) FILTER (WHERE driver = ANY(${AGENT_DRIVERS}) OR probability >= 0.7)::int AS agent_visits,
           count(*) FILTER (WHERE proven)::int AS verified_agent_visits,
           count(*) FILTER (WHERE reached_checkout)::int AS checkouts,
           count(*) FILTER (WHERE reached_checkout AND (driver = ANY(${AGENT_DRIVERS}) OR probability >= 0.7))::int AS agent_checkouts
    FROM merchant_visits WHERE livemode = ${s.livemode} AND last_at >= ${since} ${mf}`;
  const drivers = await tx<{ driver: string; visits: number }[]>`
    SELECT driver, count(*)::int AS visits FROM merchant_visits
    WHERE livemode = ${s.livemode} AND last_at >= ${since} ${mf} GROUP BY driver ORDER BY visits DESC`;
  const agents = await tx<{ agent: string; verified: boolean; visits: number }[]>`
    SELECT agent, bool_or(proven) AS verified, count(*)::int AS visits FROM merchant_visits
    WHERE livemode = ${s.livemode} AND last_at >= ${since} AND agent IS NOT NULL AND (driver = ANY(${AGENT_DRIVERS}) OR probability >= 0.35) ${mf}
    GROUP BY agent ORDER BY visits DESC LIMIT 20`;
  // Checkout funnel per driver: visits → reached checkout → reached Pay → assessed at Pay.
  const funnel = await tx<{ driver: string; visits: number; reached_checkout: number; reached_pay: number; assessed: number }[]>`
    SELECT v.driver, count(*)::int AS visits,
           count(*) FILTER (WHERE v.reached_checkout)::int AS reached_checkout,
           count(*) FILTER (WHERE v.reached_pay)::int AS reached_pay,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM assessments a WHERE a.visit_id = v.visit_id))::int AS assessed
    FROM merchant_visits v WHERE v.livemode = ${s.livemode} AND v.last_at >= ${since} ${merchantFilter(tx, s, "v.merchant_id")}
    GROUP BY v.driver ORDER BY visits DESC`;
  const daily = await tx<{ day: string; visits: number; agent_visits: number }[]>`
    SELECT to_char(date_trunc('day', last_at), 'YYYY-MM-DD') AS day, count(*)::int AS visits,
           count(*) FILTER (WHERE driver = ANY(${AGENT_DRIVERS}) OR probability >= 0.7)::int AS agent_visits
    FROM merchant_visits WHERE livemode = ${s.livemode} AND last_at >= ${since} ${mf}
    GROUP BY 1 ORDER BY 1`;
  const [orders] = await tx<{ assessed: number; review: number; challenge: number }[]>`
    SELECT count(*)::int AS assessed,
           count(*) FILTER (WHERE response->>'suggested_action' = 'review')::int AS review,
           count(*) FILTER (WHERE response->>'suggested_action' = 'challenge')::int AS challenge
    FROM assessments WHERE livemode = ${s.livemode} AND created_at >= ${since} ${mf}`;
  return { days, totals: { ...totals!, agent_share: totals!.visits ? totals!.agent_visits / totals!.visits : 0 }, drivers, agents, funnel, daily, orders };
}

export interface VisitFilters { driver?: string; agentsOnly?: boolean; bucket?: string; labOnly?: boolean; before?: string; limit?: number; activeSinceMs?: number }

export async function listVisits(tx: MerchantTx, s: Scope, f: VisitFilters) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  return tx`
    SELECT v.visit_id, v.merchant_id, m.company, v.livemode, v.first_at, v.last_at, v.settled, v.probability, v.bucket, v.type,
           v.agent, v.proven, v.driver, v.handover, v.page_count, v.reached_checkout, v.reached_pay, v.lab_label, v.lab_verified,
           (SELECT count(*)::int FROM jsonb_array_elements(coalesce(v.summary->'checks', '[]'::jsonb)) c WHERE c->>'status' = 'mismatch') AS checks_failed,
           (SELECT count(*)::int FROM jsonb_array_elements(coalesce(v.summary->'checks', '[]'::jsonb)) c WHERE c->>'status' IN ('match', 'mismatch')) AS checks_compared,
           v.summary->'network' AS network, v.summary->>'userAgent' AS user_agent, v.summary->'paths' AS paths,
           (SELECT count(*)::int FROM assessments a WHERE a.visit_id = v.visit_id) AS assessments
    FROM merchant_visits v JOIN merchants m USING (merchant_id)
    WHERE v.livemode = ${s.livemode} ${merchantFilter(tx, s, "v.merchant_id")}
      ${f.driver ? tx`AND v.driver = ${f.driver}` : tx``}
      ${f.agentsOnly ? tx`AND (v.driver = ANY(${AGENT_DRIVERS}) OR v.probability >= 0.7)` : tx``}
      ${f.bucket ? tx`AND v.bucket = ${f.bucket}` : tx``}
      ${f.labOnly ? tx`AND v.lab_label IS NOT NULL` : tx``}
      ${f.before ? tx`AND v.last_at < ${new Date(f.before)}` : tx``}
      ${f.activeSinceMs ? tx`AND v.last_at >= ${new Date(Date.now() - f.activeSinceMs)}` : tx``}
    ORDER BY v.last_at DESC LIMIT ${limit}`;
}

export interface OrderFilters { action?: string; driver?: string; before?: string; limit?: number }

export async function listOrders(tx: MerchantTx, s: Scope, f: OrderFilters) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  return tx`
    SELECT a.assessment_id, a.merchant_id, m.company, a.livemode, a.order_id, a.amount, a.currency, a.visit_id, a.final, a.token_status,
           a.created_at, a.updated_at, a.response->>'driver' AS driver, a.response->>'suggested_action' AS suggested_action,
           (a.response->>'score')::float AS score, a.response->'agent' AS agent,
           (SELECT f.outcome FROM feedback f WHERE f.assessment_id = a.assessment_id ORDER BY f.created_at DESC LIMIT 1) AS outcome
    FROM assessments a JOIN merchants m USING (merchant_id)
    WHERE a.livemode = ${s.livemode} ${merchantFilter(tx, s, "a.merchant_id")}
      ${f.action ? tx`AND a.response->>'suggested_action' = ${f.action}` : tx``}
      ${f.driver ? tx`AND a.response->>'driver' = ${f.driver}` : tx``}
      ${f.before ? tx`AND a.created_at < ${new Date(f.before)}` : tx``}
    ORDER BY a.created_at DESC LIMIT ${limit}`;
}

export async function getOrder(tx: MerchantTx, s: Scope, assessmentId: string) {
  const [a] = await tx`
    SELECT a.assessment_id, a.merchant_id, m.company, a.visit_id, a.token_status, a.header_count, a.server_ms, a.response, a.final, a.created_at
    FROM assessments a JOIN merchants m USING (merchant_id)
    WHERE a.assessment_id = ${assessmentId} AND a.livemode = ${s.livemode} ${merchantFilter(tx, s, "a.merchant_id")}`;
  if (!a) return null;
  const feedback = await tx`SELECT outcome, note, created_at FROM feedback WHERE assessment_id = ${assessmentId} ORDER BY created_at DESC`;
  return { ...a, feedback };
}

export async function recentPayEvents(tx: MerchantTx, s: Scope, sinceMs: number) {
  return tx`
    SELECT e.session_id, e.merchant_id, e.name, e.path, e.created_at,
           (SELECT v.visit_id FROM merchant_visits v WHERE v.merchant_id = e.merchant_id AND v.session_id = e.session_id AND v.livemode = e.livemode ORDER BY v.last_at DESC LIMIT 1) AS visit_id
    FROM merchant_events e
    WHERE e.livemode = ${s.livemode} AND e.created_at >= ${new Date(Date.now() - sinceMs)} ${merchantFilter(tx, s, "e.merchant_id")}
      AND ((e.kind = 'event' AND e.name IN ('pay_clicked', 'checkout_started')) OR e.kind = 'assess')
    ORDER BY e.created_at DESC LIMIT 50`;
}
