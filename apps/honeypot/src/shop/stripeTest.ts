/**
 * Stripe **test mode only** — the uHoney checkout's real payment flow, so an agent can complete a
 * genuine Stripe payment end to end (with Stripe's published test cards) without any real money or
 * real card data ever being involved.
 *
 * Why it can't take real payments:
 *   - stripeTestConfig() returns null unless the secret key starts with sk_test_/rk_test_ AND the
 *     publishable key with pk_test_. A live key disables the provider (and logs why).
 *   - Every PaymentIntent we read back is checked for livemode === false; anything else is refused.
 *   - Stripe's test mode itself rejects real card numbers.
 *
 * Card data never reaches uHoney: the Payment Element is an iframe served by js.stripe.com, the
 * browser confirms the PaymentIntent with Stripe directly, and the server only ever sees the
 * PaymentIntent id, which it re-fetches from Stripe to learn the real outcome (status, decline
 * code, test card brand/last4). The client is never trusted for the result.
 *
 * Talks to the Stripe REST API with fetch — no SDK dependency.
 */

export interface StripeTestConfig {
  secretKey: string;
  publishableKey: string;
}

export function stripeTestConfig(env: NodeJS.ProcessEnv = process.env): StripeTestConfig | null {
  const secretKey = env.STRIPE_TEST_SECRET_KEY?.trim() ?? "";
  const publishableKey = env.STRIPE_TEST_PUBLISHABLE_KEY?.trim() ?? "";
  if (!secretKey && !publishableKey) return null;
  if (!/^(sk|rk)_test_/.test(secretKey) || !/^pk_test_/.test(publishableKey)) {
    if (!warnedNonTest) {
      warnedNonTest = true;
      console.warn("[stripe_test] disabled: STRIPE_TEST_SECRET_KEY must start with sk_test_/rk_test_ and STRIPE_TEST_PUBLISHABLE_KEY with pk_test_ — live keys are never used");
    }
    return null;
  }
  return { secretKey, publishableKey };
}
let warnedNonTest = false;

/** CSP additions the Payment Element needs (scripts + iframes + API calls to Stripe). */
export const STRIPE_CSP =
  "default-src 'self'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src 'self' https://api.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.stripe.com; frame-ancestors 'none'; base-uri 'self'";

const API = "https://api.stripe.com/v1";

async function stripeRequest<T>(cfg: StripeTestConfig, method: "GET" | "POST", pathAndQuery: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as T & { error?: { message?: string; type?: string } };
  if (!res.ok) throw new Error(`stripe ${method} ${pathAndQuery.split("?")[0]}: ${res.status} ${json.error?.type ?? ""} ${json.error?.message ?? ""}`.trim());
  return json;
}

export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: string;
  livemode: boolean;
  client_secret?: string;
  metadata?: Record<string, string>;
  last_payment_error?: { code?: string; decline_code?: string; type?: string } | null;
  latest_charge?: { payment_method_details?: { card?: { brand?: string; last4?: string; checks?: Record<string, string | null> } } } | string | null;
}

export async function createTestPaymentIntent(cfg: StripeTestConfig, amountCents: number, metadata: Record<string, string>): Promise<StripePaymentIntent> {
  const form: Record<string, string> = {
    amount: String(amountCents),
    currency: "eur",
    "payment_method_types[]": "card",
    description: "uHoney test order (Stripe test mode)",
  };
  for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v.slice(0, 500);
  const pi = await stripeRequest<StripePaymentIntent>(cfg, "POST", "/payment_intents", form);
  if (pi.livemode) throw new Error("stripe returned a livemode PaymentIntent — refusing");
  return pi;
}

export async function retrieveTestPaymentIntent(cfg: StripeTestConfig, id: string): Promise<StripePaymentIntent> {
  if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new Error("bad payment intent id");
  const pi = await stripeRequest<StripePaymentIntent>(cfg, "GET", `/payment_intents/${id}?expand[]=latest_charge`);
  if (pi.livemode) throw new Error("stripe returned a livemode PaymentIntent — refusing");
  return pi;
}
