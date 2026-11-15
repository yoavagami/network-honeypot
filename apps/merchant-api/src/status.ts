import type { MerchantTx } from "@honeypot/merchant-db";
import type { IntegrationStatus, StatusCheck, StatusCheckId } from "@honeypot/merchant-contract";

/**
 * The integration checklist (contract: GET /v1/integration/status). Each check says what passed,
 * or exactly what to do next — the developer page, the agent file and the dashboard all show it.
 */
export async function integrationStatus(tx: MerchantTx, merchantId: string, livemode: boolean, key?: { display: string }): Promise<IntegrationStatus> {
  const now = new Date();
  const at = now.toISOString();
  const checks: StatusCheck[] = [];
  const add = (id: StatusCheckId, status: StatusCheck["status"], detail: string) => checks.push({ id, status, detail, checked_at: at });
  const ago = (d: Date) => {
    const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
    return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : `${Math.round(s / 3600)} hours ago`;
  };

  if (key) add("key_valid", "pass", `Secret key ${key.display} belongs to ${merchantId}`);
  else {
    const [k] = await tx`SELECT display FROM api_keys WHERE merchant_id = ${merchantId} AND kind = 'secret' AND livemode = ${livemode} AND revoked_at IS NULL LIMIT 1`;
    add("key_valid", k ? "pass" : "fail", k ? `Active secret key ${k.display}` : `No active ${livemode ? "live" : "test"} secret key. Create one under Settings → Keys.`);
  }

  const [page] = await tx`SELECT created_at, origin FROM merchant_events WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND kind = 'page' AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1`;
  add("tag_seen", page ? "pass" : "fail", page
    ? `Last page view ${ago(page.created_at)} from ${page.origin ?? "unknown origin"}`
    : "No page view from your site in the last 24 hours. Add the tag to your shared page layout, register the domain, and allow uhoney.shop in your Content Security Policy (script-src and connect-src).");

  const [script] = await tx`SELECT created_at FROM merchant_events WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND kind IN ('fp', 'behavior') AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1`;
  add("token_issued", script ? "pass" : page ? "fail" : "pending", script
    ? `The page script reported with a session token ${ago(script.created_at)}`
    : page ? "The tag loaded but its page script hasn't reported. If you use data-consent=\"pending\", call uhoney.consent(true) once the visitor agrees." : "Waiting for the tag.");

  const [pay] = await tx`SELECT created_at FROM merchant_events WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND kind = 'event' AND name = 'pay_clicked' AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 1`;
  add("pay_event_seen", pay ? "pass" : "fail", pay ? `Last pay_clicked ${ago(pay.created_at)}` : "No pay_clicked event yet. Call uhoney.track('pay_clicked', { orderId }) when Pay is pressed.");

  const recent = await tx<{ token_status: string; header_count: number; server_ms: number; created_at: Date }[]>`
    SELECT token_status, header_count, server_ms, created_at FROM assessments
    WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND created_at > now() - interval '7 days'
    ORDER BY created_at DESC LIMIT 20`;
  const withToken = recent.find((r) => r.token_status === "valid");
  if (withToken) add("assess_called", "pass", `Assess called with a valid session token ${ago(withToken.created_at)}`);
  else if (recent.length) add("assess_called", "fail", `Assess was called, but without a valid session token (${recent[0]!.token_status}). Send the uhoney_token value from the checkout form as session_token.`);
  else add("assess_called", "fail", "No /v1/assess call yet. Call it from your server before creating the charge.");

  if (!recent.length) add("assess_headers", "pending", "Waiting for an assess call.");
  else if (recent[0]!.header_count >= 3) add("assess_headers", "pass", `The last assess call forwarded ${recent[0]!.header_count} request headers`);
  else add("assess_headers", "fail", `The last assess call forwarded ${recent[0]!.header_count} headers. Forward the visitor's accept, accept-language, sec-ch-ua*, sec-fetch-* and signature* headers.`);

  if (!recent.length) add("assess_latency", "pending", "Waiting for assess calls.");
  else {
    const sorted = recent.map((r) => r.server_ms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    add("assess_latency", p95 < 100 ? "pass" : "fail", `95th percentile server time ${p95} ms over the last ${sorted.length} calls (target under 100 ms)`);
  }

  const endpoints = await tx`SELECT endpoint_id FROM webhook_endpoints WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND disabled_at IS NULL`;
  const [delivered] = await tx`SELECT delivered_at FROM webhook_deliveries WHERE merchant_id = ${merchantId} AND livemode = ${livemode} AND status = 'delivered' AND created_at > now() - interval '7 days' ORDER BY delivered_at DESC LIMIT 1`;
  if (delivered) add("webhook_delivered", "pass", `Last webhook delivered ${ago(delivered.delivered_at)}`);
  else if (endpoints.length) {
    const [last] = await tx`SELECT last_error, attempts FROM webhook_deliveries WHERE merchant_id = ${merchantId} AND livemode = ${livemode} ORDER BY created_at DESC LIMIT 1`;
    add("webhook_delivered", "fail", last ? `Webhook delivery failing: ${last.last_error ?? "pending"} (${last.attempts} attempts). Your endpoint must answer 2xx within 5 seconds.` : "Endpoint added; press \"Send test webhook\" in the dashboard.");
  } else add("webhook_delivered", "fail", "No webhook endpoint. Add one under Settings → Webhooks to receive final verdicts.");

  if (!livemode) add("domain_verified", "not_applicable", "Only needed for live keys");
  else {
    const [d] = await tx`SELECT host FROM merchant_domains WHERE merchant_id = ${merchantId} AND verified_at IS NOT NULL LIMIT 1`;
    add("domain_verified", d ? "pass" : "fail", d ? `${d.host} is verified` : "Verify a domain under Settings → Domains (DNS TXT record or meta tag).");
  }

  const events = await tx<{ kind: string; name: string | null; created_at: Date; origin: string | null }[]>`
    SELECT kind, name, created_at, origin FROM merchant_events WHERE merchant_id = ${merchantId} AND livemode = ${livemode}
    ORDER BY created_at DESC LIMIT 5`;
  return {
    merchant_id: merchantId,
    livemode,
    all_passed: checks.every((c) => c.status === "pass" || c.status === "not_applicable"),
    checks,
    recent_events: events.map((e) => ({ type: e.kind === "event" && e.name ? e.name : e.kind, at: new Date(e.created_at).toISOString(), origin: e.origin })),
  };
}
