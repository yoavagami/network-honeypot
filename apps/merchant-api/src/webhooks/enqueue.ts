import type { MerchantTx } from "@honeypot/merchant-db";
import { newEventId } from "../ids.js";

/**
 * Queues one delivery per active endpoint subscribed to `type` (outbox pattern: the row is written
 * in the same transaction as the change it reports; webhooks/dispatcher.ts sends it).
 */
export async function enqueueEvent(tx: MerchantTx, merchantId: string, livemode: boolean, type: string, data: unknown, opts: { endpointId?: string; isTest?: boolean } = {}): Promise<string[]> {
  const endpoints = await tx<{ endpoint_id: string }[]>`
    SELECT endpoint_id FROM webhook_endpoints
    WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND disabled_at IS NULL
      AND (${opts.endpointId ?? null}::uuid IS NULL OR endpoint_id = ${opts.endpointId ?? null}::uuid)
      AND ${type} = ANY(events)`;
  const ids: string[] = [];
  for (const e of endpoints) {
    const eventId = newEventId();
    const payload = { id: eventId, type, created_at: new Date().toISOString(), livemode, merchant_id: merchantId, data };
    await tx`
      INSERT INTO webhook_deliveries (event_id, merchant_id, endpoint_id, livemode, type, payload, is_test)
      VALUES (${eventId}, ${merchantId}, ${e.endpoint_id}, ${livemode}, ${type}, ${tx.json(payload as any)}, ${opts.isTest ?? false})`;
    ids.push(eventId);
  }
  return ids;
}
