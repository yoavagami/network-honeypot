// uhoney.mjs — server helper for the uHoney merchant API (Node 18+, no dependencies).
// Reads UHONEY_SECRET_KEY and UHONEY_WEBHOOK_SECRET from the environment. Never import this
// file into browser code.
import { createHmac, timingSafeEqual } from "node:crypto";

const API_URL = process.env.UHONEY_API_URL || "{{API_URL}}";

// Visitor request headers worth forwarding. Never cookie or authorization.
const FORWARD_HEADERS = [
  "accept", "accept-language", "accept-encoding",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
  "signature", "signature-input", "signature-agent",
];

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined; // Fetch API Headers
  const v = headers[name]; // Node / Express: lower-case keys
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Ask uHoney for a verdict before charging. Fails open: returns null on any error or after
 * `timeoutMs` (300 ms by default), so the checkout always continues.
 *
 * @param {object} p
 * @param {string|undefined|null} p.sessionToken  the uhoney_token the checkout form sent
 * @param {{id: string, amount: number, currency: string}} p.order  amount in minor units (cents)
 * @param {string} p.ip  the visitor's IP address
 * @param {object} p.headers  the visitor's request headers (Express req.headers or Fetch Headers)
 * @param {string} [p.method]  @param {string} [p.path]  @param {string} [p.host]
 */
export async function assessOrder({ sessionToken, order, ip, headers, method, path, host, timeoutMs = 300, fetchImpl = fetch }) {
  const secret = process.env.UHONEY_SECRET_KEY;
  if (!secret || !order || !ip) return null;
  const forwarded = {};
  for (const name of FORWARD_HEADERS) {
    const value = readHeader(headers, name);
    if (value) forwarded[name] = String(value).slice(0, 4096);
  }
  const body = {
    session_token: typeof sessionToken === "string" && sessionToken.startsWith("st_") ? sessionToken : undefined,
    stage: "pay",
    order: { id: String(order.id), amount: Math.round(order.amount), currency: String(order.currency).toUpperCase() },
    request: { ip, user_agent: readHeader(headers, "user-agent") ?? null, method, path, host, headers: forwarded },
  };
  try {
    const res = await fetchImpl(`${API_URL}/v1/assess`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "idempotency-key": String(order.id) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // timeout, network error, bad JSON: let the payment continue
  }
}

/** The fields worth keeping on your order record. */
export function verdictFields(assessment) {
  if (!assessment) return { uhoney_assessment_id: null, uhoney_driver: null, uhoney_action: null };
  return { uhoney_assessment_id: assessment.assessment_id, uhoney_driver: assessment.driver, uhoney_action: assessment.suggested_action };
}

/** Stripe PaymentIntent metadata (strings only, so Radar rules can use them). */
export function stripeMetadata(assessment) {
  if (!assessment) return {};
  return {
    uhoney_assessment_id: assessment.assessment_id,
    uhoney_driver: assessment.driver,
    uhoney_action: assessment.suggested_action,
    uhoney_agent: assessment.agent ? assessment.agent.id : "none",
    uhoney_agent_verified: String(Boolean(assessment.agent && assessment.agent.verified)),
    uhoney_score: String(assessment.score),
  };
}

/**
 * Check a webhook's Uhoney-Signature header ("t=<unix>,v1=<hex>") against the raw request body.
 * Use the body exactly as received, before any JSON parsing.
 */
export function verifyWebhook(rawBody, signatureHeader, secret = process.env.UHONEY_WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret || typeof signatureHeader !== "string") return false;
  const m = signatureHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b);
}
