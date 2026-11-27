import { VISIT_GAP_MS, visitSummary, SCORER_VERSION, type Visit } from "@honeypot/detection";
import type { Assessment, Policy } from "@honeypot/merchant-contract";
import type { MerchantSql, MerchantTx } from "@honeypot/merchant-db";
import { visitIdFor } from "../ids.js";
import { merchantVisits } from "./visits.js";
import { loadSessionEvents, LOOKBACK_MS } from "./load.js";
import { verdictFor, type MerchantVerdict } from "./verdict.js";
import { assessmentBody } from "../assessmentBody.js";
import { enqueueEvent } from "../webhooks/enqueue.js";
import { recordDecision } from "../decisions.js";

/**
 * Merchant scoring worker: every few seconds, rescores the sessions that received events (and
 * open visits that have now gone quiet), stores merchant_visits, updates assessments whose verdict
 * changed or became final, and queues the webhooks that report it. Runs as merchant_admin (all
 * merchants), one transaction per session.
 */

const CHECKOUT_TYPES = new Set(["SHOP_CHECKOUT_START", "SHOP_CHECKOUT_DETAILS", "SHOP_CHECKOUT_SHIPPING", "SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"]);
const PAY_TYPES = new Set(["SHOP_PAYMENT_ATTEMPT", "SHOP_ORDER_PLACED"]);
const AGENT_AT_CHECKOUT = new Set(["agent", "human_then_agent", "mixed"]);
const MAX_SESSIONS_PER_TICK = 300;

interface DirtySession { merchant_id: string; livemode: boolean; session_id: string }

export async function dirtySessions(sql: MerchantSql, watermark: Date): Promise<DirtySession[]> {
  return sql<DirtySession[]>`
    SELECT merchant_id, livemode, session_id FROM (
      SELECT DISTINCT merchant_id, livemode, session_id FROM merchant_events WHERE created_at > ${watermark}
      UNION
      SELECT merchant_id, livemode, session_id FROM merchant_visits
      WHERE NOT settled AND (last_at < now() - make_interval(secs => ${VISIT_GAP_MS / 1000}) OR scorer_version <> ${SCORER_VERSION})
      UNION
      SELECT merchant_id, livemode, session_id FROM assessments
      WHERE NOT final AND session_id IS NOT NULL AND created_at < now() - make_interval(secs => ${VISIT_GAP_MS / 1000})
    ) d LIMIT ${MAX_SESSIONS_PER_TICK}`;
}

export function visitRow(merchantId: string, livemode: boolean, sessionId: string, v: Visit, verdict: MerchantVerdict, now: Date) {
  const s = visitSummary(v, verdict.score);
  const shopTypes = new Set(v.shop.map((e) => e.event_type));
  const paths = [...new Set(v.requests.filter((r) => r.method === "GET").map((r) => r.path))].slice(0, 30);
  return {
    visit_id: visitIdFor(merchantId, v.id),
    merchant_id: merchantId,
    livemode,
    session_id: sessionId,
    first_at: s.firstAt,
    last_at: new Date(Math.max(s.lastAt.getTime(), ...v.client.map((c) => c.created_at.getTime()), ...v.shop.map((e) => e.created_at.getTime()))),
    settled: now.getTime() - s.lastAt.getTime() > VISIT_GAP_MS,
    computed_at: now,
    scorer_version: verdict.score.scorerVersion,
    probability: verdict.probability,
    bucket: verdict.score.bucket,
    type: verdict.automationType,
    agent: verdict.agent?.id ?? null,
    proven: verdict.agent?.verified ?? false,
    driver: verdict.driver,
    handover: verdict.handover,
    reasons: verdict.reasons,
    summary: {
      network: { asn: s.asn, organization: s.network, country: s.country },
      userAgent: s.userAgent,
      paths,
      confidence: verdict.confidence,
      signalsUsed: verdict.signalsUsed,
      checks: verdict.score.checks,
    },
    page_count: s.pageCount,
    reached_checkout: [...shopTypes].some((t) => CHECKOUT_TYPES.has(t)),
    reached_pay: [...shopTypes].some((t) => PAY_TYPES.has(t)),
    lab_label: s.lab,
    lab_verified: s.labVerified,
  };
}

export async function rescoreSession(tx: MerchantTx, d: DirtySession, now: Date) {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const events = await loadSessionEvents(tx, d.merchant_id, d.livemode, [d.session_id], since);
  const visits = merchantVisits(events);
  const [m] = await tx<{ policy: Partial<Policy> }[]>`SELECT policy FROM merchants WHERE merchant_id = ${d.merchant_id}`;
  const keep: string[] = [];
  const verdicts = new Map<string, { verdict: MerchantVerdict; row: ReturnType<typeof visitRow>; visit: Visit }>();
  for (const v of visits) {
    const verdict = verdictFor(v, now);
    const row = visitRow(d.merchant_id, d.livemode, d.session_id, v, verdict, now);
    keep.push(row.visit_id);
    verdicts.set(row.visit_id, { verdict, row, visit: v });
    const [prev] = await tx<{ agent_checkout_notified: boolean }[]>`
      INSERT INTO merchant_visits ${tx({ ...row, handover: row.handover ? tx.json(row.handover as any) : null, reasons: tx.json(row.reasons as any), summary: tx.json(row.summary as any) } as any)}
      ON CONFLICT (visit_id) DO UPDATE SET
        last_at = EXCLUDED.last_at, settled = EXCLUDED.settled, computed_at = EXCLUDED.computed_at, scorer_version = EXCLUDED.scorer_version,
        probability = EXCLUDED.probability, bucket = EXCLUDED.bucket, type = EXCLUDED.type, agent = EXCLUDED.agent, proven = EXCLUDED.proven,
        driver = EXCLUDED.driver, handover = EXCLUDED.handover, reasons = EXCLUDED.reasons, summary = EXCLUDED.summary,
        page_count = EXCLUDED.page_count, reached_checkout = EXCLUDED.reached_checkout, reached_pay = EXCLUDED.reached_pay,
        lab_label = EXCLUDED.lab_label, lab_verified = EXCLUDED.lab_verified
      RETURNING agent_checkout_notified`;
    // An agent-driven visit reached checkout: tell the merchant once (live feed / alerts).
    if (!prev?.agent_checkout_notified && row.reached_checkout && AGENT_AT_CHECKOUT.has(row.driver) && verdict.probability >= 0.7) {
      const checkout = v.shop.find((e) => CHECKOUT_TYPES.has(e.event_type));
      const page = v.requests.filter((r) => r.method === "GET" && checkout && r.created_at <= checkout.created_at).at(-1)?.path ?? null;
      await enqueueEvent(tx, d.merchant_id, d.livemode, "checkout.agent_started", {
        visit_id: row.visit_id, page, at: (checkout?.created_at ?? now).toISOString(), driver: row.driver, agent: verdict.agent,
      });
      await tx`UPDATE merchant_visits SET agent_checkout_notified = true WHERE visit_id = ${row.visit_id}`;
    }
  }
  // Visits merge and split as events arrive; drop ids that no longer exist in the loaded window.
  await tx`DELETE FROM merchant_visits WHERE merchant_id = ${d.merchant_id} AND livemode = ${d.livemode} AND session_id = ${d.session_id}
           AND first_at >= ${since} AND NOT (visit_id = ANY(${keep}::text[]))`;

  // Assessments of this session: refresh the verdict; send assessment.updated on a change or when final.
  const open = await tx<{ assessment_id: string; visit_id: string | null; response: Assessment; intent_ref: string | null; created_at: Date }[]>`
    SELECT assessment_id, visit_id, response, intent_ref, created_at FROM assessments
    WHERE merchant_id = ${d.merchant_id} AND livemode = ${d.livemode} AND session_id = ${d.session_id} AND NOT final`;
  for (const a of open) {
    const entry = (a.visit_id ? verdicts.get(a.visit_id) : undefined)
      ?? [...verdicts.values()].find((x) => x.visit.requests.some((r) => r.created_at.getTime() <= new Date(a.created_at).getTime() + 1000 && x.visit.requests.at(-1)!.created_at.getTime() >= new Date(a.created_at).getTime() - 1000));
    const quiet = now.getTime() - new Date(a.created_at).getTime() > VISIT_GAP_MS;
    const final = entry ? entry.row.settled : quiet;
    const prev = a.response;
    const next: Assessment = entry
      ? assessmentBody({ assessmentId: a.assessment_id, merchantId: d.merchant_id, livemode: d.livemode, final, createdAt: new Date(prev.created_at), updatedAt: now, order: prev.order, intentRef: a.intent_ref }, entry.verdict, m?.policy)
      : { ...prev, final, updated_at: now.toISOString() };
    const changed = next.driver !== prev.driver || next.suggested_action !== prev.suggested_action || next.decision !== prev.decision
      || (next.agent?.id ?? null) !== (prev.agent?.id ?? null);
    if (!changed && !final) {
      // Keep the stored copy fresh (score, reasons) without notifying.
      await tx`UPDATE assessments SET response = ${tx.json({ ...next, updated_at: prev.updated_at } as any)}, visit_id = coalesce(${entry?.row.visit_id ?? null}, visit_id) WHERE assessment_id = ${a.assessment_id}`;
      continue;
    }
    await tx`UPDATE assessments SET response = ${tx.json(next as any)}, decision = ${next.decision}, final = ${final}, updated_at = ${now}, visit_id = coalesce(${entry?.row.visit_id ?? null}, visit_id) WHERE assessment_id = ${a.assessment_id}`;
    await recordDecision(tx, next, m?.policy);
    await enqueueEvent(tx, d.merchant_id, d.livemode, "assessment.updated", { assessment: next, previous: { driver: prev.driver, suggested_action: prev.suggested_action, decision: prev.decision } });
  }
}

export async function runScoringTick(sql: MerchantSql, watermark: Date): Promise<{ watermark: Date; sessions: number }> {
  const tickStart = new Date();
  const dirty = await dirtySessions(sql, watermark);
  for (const d of dirty) await sql.begin((tx) => rescoreSession(tx, d, tickStart));
  return { watermark: dirty.length >= MAX_SESSIONS_PER_TICK ? watermark : new Date(tickStart.getTime() - 2000), sessions: dirty.length };
}

/** Retention (hourly): raw IPs after 24 h, events and visits after the merchant's retention, sessions when expired. */
export async function runRetention(sql: MerchantSql) {
  await sql`UPDATE merchant_events SET ip = NULL WHERE ip IS NOT NULL AND created_at < now() - interval '24 hours'`;
  await sql`DELETE FROM merchant_events e USING merchants m WHERE e.merchant_id = m.merchant_id AND e.created_at < now() - make_interval(days => m.retention_days)`;
  await sql`DELETE FROM merchant_visits v USING merchants m WHERE v.merchant_id = m.merchant_id AND v.last_at < now() - make_interval(days => m.retention_days)`;
  await sql`DELETE FROM assessments WHERE created_at < now() - interval '400 days'`;
  await sql`DELETE FROM intents WHERE created_at < now() - interval '400 days'`;
  // Evidence outlives the assessment: card disputes can arrive up to about 540 days after the order.
  // Whole orders only, so a kept record's hash chain is never cut short.
  await sql`DELETE FROM evidence_entries WHERE (merchant_id, livemode, order_id) IN (
              SELECT merchant_id, livemode, order_id FROM evidence_entries
              GROUP BY 1, 2, 3 HAVING max(created_at) < now() - interval '540 days')`;
  await sql`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days'`;
  await sql`DELETE FROM merchant_user_sessions WHERE expires_at < now()`;
  await sql`DELETE FROM merchant_invites WHERE expires_at < now() - interval '30 days'`;
  await sql`UPDATE public_page_hits SET ip = NULL WHERE ip IS NOT NULL AND created_at < now() - interval '30 days'`;
  await sql`DELETE FROM public_page_hits WHERE created_at < now() - interval '365 days'`;
  await sql`UPDATE public_site_alerts SET ip = NULL WHERE ip IS NOT NULL AND created_at < now() - interval '30 days'`;
  await sql`DELETE FROM public_site_alerts WHERE created_at < now() - interval '365 days'`;
}

export function startWorkers(sql: MerchantSql, opts: { scorerIntervalMs: number; webhookIntervalMs: number; dispatch: () => Promise<unknown>; log: (o: object) => void }) {
  let watermark = new Date(Date.now() - VISIT_GAP_MS - 60_000);
  let scoring = false;
  let dispatching = false;
  const timers = [
    setInterval(() => {
      if (scoring) return;
      scoring = true;
      runScoringTick(sql, watermark)
        .then((r) => { watermark = r.watermark; })
        .catch((err) => opts.log({ msg: "merchant scoring tick failed", err: String(err?.message ?? err) }))
        .finally(() => { scoring = false; });
    }, opts.scorerIntervalMs),
    setInterval(() => {
      if (dispatching) return;
      dispatching = true;
      opts.dispatch().catch((err) => opts.log({ msg: "webhook dispatch failed", err: String(err?.message ?? err) })).finally(() => { dispatching = false; });
    }, opts.webhookIntervalMs),
    setInterval(() => { runRetention(sql).catch((err) => opts.log({ msg: "retention failed", err: String(err?.message ?? err) })); }, 3600_000),
  ];
  for (const t of timers) t.unref();
  return () => timers.forEach(clearInterval);
}

