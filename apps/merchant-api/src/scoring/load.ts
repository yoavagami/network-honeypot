import type { MerchantTx } from "@honeypot/merchant-db";
import type { MerchantEventRow } from "./visits.js";

export const LOOKBACK_MS = 24 * 3600_000;

/** Events of the given sessions (one merchant + mode), oldest first. Caller sets the tenant scope. */
export async function loadSessionEvents(tx: MerchantTx, merchantId: string, livemode: boolean, sessionIds: string[], since: Date): Promise<MerchantEventRow[]> {
  if (!sessionIds.length) return [];
  const rows = await tx<MerchantEventRow[]>`
    SELECT event_id, session_id, kind, name, created_at, page_view_id, path, host(ip) AS ip, user_agent, accept_language, identity, data, lab_label, lab_verified
    FROM merchant_events
    WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND session_id = ANY(${sessionIds}::uuid[]) AND created_at >= ${since}
    ORDER BY created_at, event_id
    LIMIT 20000`;
  return rows;
}
