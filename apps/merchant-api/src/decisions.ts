import type { Assessment, Policy } from "@honeypot/merchant-contract";
import type { MerchantTx } from "@honeypot/merchant-db";

/**
 * Appends a decision to the history (table decisions): the first one at Pay, then each change the
 * scoring worker makes. The assessment row keeps only the latest; this is what the order's
 * evidence view will show.
 */
export async function recordDecision(tx: MerchantTx, a: Assessment, policy: Partial<Policy> | undefined) {
  await tx`
    INSERT INTO decisions (merchant_id, livemode, assessment_id, order_id, decision, legitimacy_score,
                           intent_status, intent_score, reasons, policy, scorer_version, final, created_at)
    VALUES (${a.merchant_id}, ${a.livemode}, ${a.assessment_id}, ${a.order.id}, ${a.decision}, ${a.legitimacy.score},
            ${a.intent.status}, ${a.intent.score}, ${tx.json(a.reasons as any)}, ${tx.json((policy ?? {}) as any)}, ${a.scorer_version},
            ${a.final}, ${a.updated_at})`;
}
