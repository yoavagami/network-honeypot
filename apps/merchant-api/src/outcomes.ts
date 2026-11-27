import { z } from "zod";
import { FEEDBACK_OUTCOMES } from "@honeypot/merchant-contract";
import type { MerchantSql, MerchantTx } from "@honeypot/merchant-db";
import type { Scope } from "./queries.js";

/**
 * Order outcomes: what really happened to an order (table feedback). Three sources:
 *   api        the merchant's server, POST /v1/feedback
 *   dashboard  set by hand on the order page, by a merchant user or a uHoney admin
 *   lab        recorded here for orders from uHoney's own verified lab runs, whose kind (agent or
 *              human) is ground truth
 */
export const outcomeInput = z.object({
  outcome: z.enum(FEEDBACK_OUTCOMES),
  note: z.string().trim().max(500).optional(),
});

/** Sets an outcome on one order (an assessment) from the dashboard. Null if there's no such order in scope. */
export async function setOrderOutcome(tx: MerchantTx, s: Scope, assessmentId: string, input: z.infer<typeof outcomeInput>, actor: string) {
  if (!/^as_[A-Za-z0-9]{20}$/.test(assessmentId)) return null;
  const [a] = await tx<{ merchant_id: string; livemode: boolean; order_id: string }[]>`
    SELECT merchant_id, livemode, order_id FROM assessments
    WHERE assessment_id = ${assessmentId} AND livemode = ${s.livemode} ${s.merchantId ? tx`AND merchant_id = ${s.merchantId}` : tx``}`;
  if (!a) return null;
  await tx`INSERT INTO feedback (merchant_id, livemode, assessment_id, order_id, outcome, note, source, actor)
           VALUES (${a.merchant_id}, ${a.livemode}, ${assessmentId}, ${a.order_id}, ${input.outcome}, ${input.note || null}, 'dashboard', ${actor})`;
  return { merchantId: a.merchant_id, orderId: a.order_id };
}

export const labRunsInput = z.object({
  runs: z.array(z.object({ label: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), kind: z.enum(["agent", "human"]) })).max(2000),
});

/** Stores the kind of each lab run (sent by admin-api, which owns lab runs). */
export async function syncLabRunKinds(sql: MerchantSql, runs: z.infer<typeof labRunsInput>["runs"]) {
  if (!runs.length) return 0;
  await sql`
    INSERT INTO lab_run_kinds ${sql(runs.map((r) => ({ label: r.label, kind: r.kind })))}
    ON CONFLICT (label) DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()`;
  return runs.length;
}

/**
 * Records the outcome of every final order whose visit came from a verified lab run of known kind:
 * confirmed_agent for agent runs, confirmed_human for human runs. Once per order.
 */
export async function applyLabOutcomes(sql: MerchantSql): Promise<number> {
  const rows = await sql`
    INSERT INTO feedback (merchant_id, livemode, assessment_id, order_id, outcome, note, source, actor)
    SELECT a.merchant_id, a.livemode, a.assessment_id, a.order_id,
           CASE k.kind WHEN 'agent' THEN 'confirmed_agent' ELSE 'confirmed_human' END, 'Lab run ' || v.lab_label, 'lab', 'uhoney'
    FROM assessments a
    JOIN merchant_visits v ON v.visit_id = a.visit_id
    JOIN lab_run_kinds k ON k.label = v.lab_label
    WHERE a.final AND v.lab_verified
      AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.assessment_id = a.assessment_id AND f.source = 'lab')
    ON CONFLICT DO NOTHING
    RETURNING 1`;
  return rows.length;
}

/** What a merchant sees of an outcome: uHoney's own entries (lab, admins) without internal detail. */
export function merchantFeedbackView(f: { outcome: string; note: string | null; source: string; actor: string | null; created_at: Date }) {
  if (f.source === "lab") return { ...f, note: null, actor: "uHoney" };
  if (f.actor?.startsWith("admin:")) return { ...f, actor: "uHoney" };
  return f;
}
