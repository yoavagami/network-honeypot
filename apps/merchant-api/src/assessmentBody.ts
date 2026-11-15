import type { Assessment, Policy } from "@honeypot/merchant-contract";
import { suggestedAction, type MerchantVerdict } from "./scoring/verdict.js";

/** Builds the contract's Assessment object from a verdict. */
export function assessmentBody(a: {
  assessmentId: string; merchantId: string; livemode: boolean; final: boolean; createdAt: Date; updatedAt: Date;
  order: { id: string; amount: number; currency: string };
}, v: MerchantVerdict, policy: Partial<Policy> | undefined): Assessment {
  return {
    assessment_id: a.assessmentId,
    merchant_id: a.merchantId,
    livemode: a.livemode,
    final: a.final,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
    order: a.order,
    driver: v.driver,
    handover: v.handover,
    automation_type: v.automationType,
    agent: v.agent,
    score: v.probability,
    confidence: v.confidence,
    reasons: v.reasons,
    signals_used: v.signalsUsed,
    suggested_action: suggestedAction(v, policy),
    scorer_version: v.score.scorerVersion,
  };
}
