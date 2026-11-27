import type { Assessment, Policy } from "@honeypot/merchant-contract";
import { decisionFor, type MerchantVerdict } from "./scoring/verdict.js";

/**
 * Builds the contract's Assessment object from a verdict. The legitimacy and intent checks aren't
 * built yet: their fields say so (evaluated: false, status not_provided / not_evaluated). The
 * decision comes from the merchant's policy.
 */
export function assessmentBody(a: {
  assessmentId: string; merchantId: string; livemode: boolean; final: boolean; createdAt: Date; updatedAt: Date;
  order: { id: string; amount: number; currency: string };
  intentRef?: string | null;
}, v: MerchantVerdict, policy: Partial<Policy> | undefined): Assessment {
  return {
    assessment_id: a.assessmentId,
    merchant_id: a.merchantId,
    livemode: a.livemode,
    final: a.final,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
    // The cart detail a merchant sends (items, shipping, payment) stays out of the response.
    order: { id: a.order.id, amount: a.order.amount, currency: a.order.currency },
    driver: v.driver,
    handover: v.handover,
    automation_type: v.automationType,
    agent: v.agent,
    score: v.probability,
    confidence: v.confidence,
    reasons: v.reasons,
    signals_used: v.signalsUsed,
    scorer_version: v.score.scorerVersion,
    decision: decisionFor(v, policy),
    legitimacy: { evaluated: false, score: null, reasons: [] },
    intent: { status: a.intentRef ? "not_evaluated" : "not_provided", score: null, violations: [] },
    evidence_id: null,
  };
}
