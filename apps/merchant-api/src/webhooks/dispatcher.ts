import type { MerchantSql } from "@honeypot/merchant-db";
import { decrypt } from "../crypto.js";
import { outbound } from "./http.js";
import { signatureHeader } from "./sign.js";

/** Seconds to wait after attempt n (1-based). Deliveries older than 24 h are given up. */
const BACKOFF_S = [30, 120, 600, 1800, 3600, 7200, 14400, 28800];
const GIVE_UP_MS = 24 * 3600_000;

export interface DispatchOptions { encryptionKey: string; allowPrivate?: boolean; batch?: number; send?: typeof outbound }

export async function dispatchDue(sql: MerchantSql, opts: DispatchOptions): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const due = await sql.begin(async (tx) => tx<{ event_id: string; payload: unknown; url: string; secret_encrypted: string; attempts: number; created_at: Date }[]>`
    UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '60 seconds'
    FROM webhook_endpoints e
    WHERE d.endpoint_id = e.endpoint_id AND d.event_id IN (
      SELECT event_id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at LIMIT ${opts.batch ?? 20} FOR UPDATE SKIP LOCKED)
    RETURNING d.event_id, d.payload, e.url, e.secret_encrypted, d.attempts, d.created_at`);
  await Promise.all(due.map(async (d) => {
    const body = JSON.stringify(d.payload);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const secret = decrypt(opts.encryptionKey, d.secret_encrypted);
      const res = await (opts.send ?? outbound)({ url: d.url, method: "POST", body, allowPrivate: opts.allowPrivate, timeoutMs: 5000, maxBytes: 4096,
        headers: { "content-type": "application/json", "uhoney-signature": signatureHeader(secret, body), "uhoney-event-id": d.event_id } });
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : "delivery failed";
    }
    const attempts = d.attempts + 1;
    if (!error) {
      sent++;
      await sql`UPDATE webhook_deliveries SET status = 'delivered', attempts = ${attempts}, last_status = ${status}, last_error = NULL, delivered_at = now() WHERE event_id = ${d.event_id}`;
      return;
    }
    const giveUp = Date.now() - new Date(d.created_at).getTime() > GIVE_UP_MS || attempts > BACKOFF_S.length;
    if (giveUp) failed++;
    const wait = BACKOFF_S[Math.min(attempts, BACKOFF_S.length) - 1]!;
    await sql`
      UPDATE webhook_deliveries SET attempts = ${attempts}, last_status = ${status}, last_error = ${error},
        status = ${giveUp ? "failed" : "pending"}, next_attempt_at = now() + make_interval(secs => ${wait})
      WHERE event_id = ${d.event_id}`;
  }));
  return { sent, failed };
}
