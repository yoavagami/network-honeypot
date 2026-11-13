/**
 * Payment providers for the uHoney checkout. The checkout only talks to this interface, so
 * moving to a real flow means adding a provider (e.g. Stripe Payment Element: card data goes
 * from the browser straight to Stripe, the server only ever sees a PaymentIntent id) and
 * listing it in SHOP_PAYMENT_PROVIDERS — no checkout/route changes.
 *
 * The providers here never accept real payment data:
 *   - test_card: a realistic card form in "test mode". Its card inputs have no `name`, so the
 *     browser never submits them; static/checkout.js accepts only the published test numbers
 *     below and posts back a result code + the test card's last four — any other number is
 *     declined in the browser and only "non-test number, length N, Luhn valid/invalid" is sent.
 *   - bank_transfer: no account details asked for or shown; the order is placed as "awaiting
 *     payment" and the confirmation says the invoice with payment details follows by email.
 */

import { stripeTestConfig, retrieveTestPaymentIntent, type StripePaymentIntent } from "./stripeTest.js";

export type PaymentStatus = "paid" | "pending" | "declined" | "error";

export interface PaymentOutcome {
  status: PaymentStatus;
  /** Shown to the shopper on decline/error. */
  message?: string;
  /** Recorded on the order event — never raw payment data. */
  metadata: Record<string, unknown>;
}

export interface PaymentProvider {
  id: string;
  label: string;
  description: string;
  /** HTML for this option's panel inside the payment form. */
  renderFields(): string;
  /** Client scripts the panel needs (served from /assets). */
  scripts: string[];
  handle(body: Record<string, unknown>, ctx: PaymentContext): PaymentOutcome | Promise<PaymentOutcome>;
}

export interface PaymentContext {
  totalCents: number;
  /** The Stripe test PaymentIntent created for this checkout (signed checkout cookie). */
  stripePaymentIntent?: string;
}

/** Stripe's published test card numbers — the only numbers the test form will ever accept. */
export const TEST_CARDS: Record<string, { brand: string; result: "approved" | "declined" | "insufficient_funds" }> = {
  "4242424242424242": { brand: "visa", result: "approved" },
  "4000056655665556": { brand: "visa", result: "approved" },
  "5555555555554444": { brand: "mastercard", result: "approved" },
  "2223003122003222": { brand: "mastercard", result: "approved" },
  "378282246310005": { brand: "amex", result: "approved" },
  "4000000000000002": { brand: "visa", result: "declined" },
  "4000000000009995": { brand: "visa", result: "insufficient_funds" },
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

export const testCardProvider: PaymentProvider = {
  id: "test_card",
  label: "Credit or debit card",
  description: "Visa, Mastercard, American Express",
  scripts: ["/assets/checkout.js"],
  renderFields: () => `
    <div class="card-widget" data-provider="test_card">
      <div class="card-widget-head"><span>Card details</span><span class="test-badge">TEST MODE</span></div>
      <label>Card number<input id="cc-number" inputmode="numeric" autocomplete="off" placeholder="1234 1234 1234 1234" maxlength="23" /></label>
      <div class="row">
        <label>Expiry date<input id="cc-exp" inputmode="numeric" autocomplete="off" placeholder="MM / YY" maxlength="7" /></label>
        <label>Security code<input id="cc-cvc" inputmode="numeric" autocomplete="off" placeholder="CVC" maxlength="4" /></label>
      </div>
      <label>Name on card<input id="cc-name" autocomplete="off" placeholder="Full name" /></label>
      <input type="hidden" name="card_result" value="" />
      <input type="hidden" name="card_brand" value="" />
      <input type="hidden" name="card_last4" value="" />
      <input type="hidden" name="card_number_length" value="" />
      <input type="hidden" name="card_luhn_valid" value="" />
      <input type="hidden" name="card_fields_filled" value="" />
      <p class="card-error" role="alert" hidden></p>
    </div>`,
  handle(body) {
    const result = str(body.card_result);
    const meta = {
      card_result: result || "missing",
      card_brand: str(body.card_brand) || null,
      card_number_length: Number(str(body.card_number_length)) || null,
      card_luhn_valid: str(body.card_luhn_valid) === "true",
      card_fields_filled: str(body.card_fields_filled) || null,
    };
    switch (result) {
      case "approved_test":
        return { status: "paid", metadata: { ...meta, card_last4: str(body.card_last4).replace(/\D/g, "").slice(-4) } };
      case "declined_test":
        return { status: "declined", message: "Your card was declined. Please try a different card.", metadata: meta };
      case "insufficient_funds_test":
        return { status: "declined", message: "Your card has insufficient funds.", metadata: meta };
      case "rejected_non_test":
        return { status: "declined", message: "Your card was declined. Please check the details or use a different card.", metadata: meta };
      case "incomplete":
        return { status: "error", message: "Please complete your card details.", metadata: meta };
      default:
        // JavaScript didn't run (or the form was posted directly) — no card data could have been read.
        return { status: "error", message: "Please enter your card details.", metadata: meta };
    }
  },
};

export const bankTransferProvider: PaymentProvider = {
  id: "bank_transfer",
  label: "Bank transfer",
  description: "Pay by invoice — we email payment details, your order ships once payment is received",
  scripts: [],
  renderFields: () => `
    <div class="bank-panel">
      <p>After you place your order we email you an invoice with our bank details and your order number as the payment reference. Please pay within 7 days — your order ships as soon as the payment arrives.</p>
    </div>`,
  handle: () => ({ status: "pending", metadata: { bank_transfer: true } }),
};

/** PaymentIntents already turned into an order — a replayed id can't place a second one. */
const consumedIntents = new Set<string>();

const DECLINE_MESSAGES: Record<string, string> = {
  insufficient_funds: "Your card has insufficient funds.",
  expired_card: "Your card has expired.",
  incorrect_cvc: "Your card's security code is incorrect.",
  processing_error: "An error occurred while processing your card. Please try again.",
};

/**
 * Stripe test mode (shop/stripeTest.ts). The Payment Element (a js.stripe.com iframe) collects the
 * test card and confirms the PaymentIntent with Stripe from the browser; this handler only gets the
 * PaymentIntent id, checks it is the one created for this checkout, and re-fetches it from Stripe
 * for the real outcome. Only available with sk_test_/pk_test_ keys.
 */
export const stripeTestProvider: PaymentProvider = {
  id: "stripe_test",
  label: "Credit or debit card",
  description: "Visa, Mastercard, American Express — processed by Stripe (test mode)",
  scripts: ["https://js.stripe.com/v3/", "/assets/stripe-checkout.js"],
  renderFields: () => `
    <div class="card-widget" data-provider="stripe_test">
      <div class="card-widget-head"><span>Card details</span><span class="test-badge">STRIPE TEST MODE</span></div>
      <div id="stripe-payment-element"><p class="muted small">Loading secure card form…</p></div>
      <p class="muted small">Test mode — no real charge. Use a Stripe test card, e.g. 4242 4242 4242 4242, any future expiry date and any CVC. Real cards are rejected.</p>
      <input type="hidden" name="stripe_payment_intent" value="" />
      <input type="hidden" name="stripe_client_error" value="" />
      <p class="card-error" role="alert" hidden></p>
    </div>`,
  async handle(body, ctx) {
    const cfg = stripeTestConfig();
    const piId = str(body.stripe_payment_intent).trim();
    const clientError = str(body.stripe_client_error).replace(/[^a-z_]/gi, "").slice(0, 64) || null;
    const meta: Record<string, unknown> = { stripe_client_error: clientError, stripe_payment_intent: piId || null };
    if (!cfg) return { status: "error", message: "Card payments are unavailable right now. Please choose another method.", metadata: { ...meta, stripe: "not_configured" } };
    if (!piId) {
      return { status: "error", message: clientError?.startsWith("incomplete") || clientError?.startsWith("invalid") ? "Please complete your card details." : "Please enter your card details.", metadata: { ...meta, card_result: "missing" } };
    }
    if (piId !== ctx.stripePaymentIntent || consumedIntents.has(piId)) {
      return { status: "error", message: "Your payment session expired. Please try again.", metadata: { ...meta, card_result: "intent_mismatch" } };
    }
    let pi: StripePaymentIntent;
    try {
      pi = await retrieveTestPaymentIntent(cfg, piId);
    } catch (err) {
      return { status: "error", message: "We couldn't verify your payment. Please try again.", metadata: { ...meta, card_result: "verify_failed", error: err instanceof Error ? err.message.slice(0, 200) : "unknown" } };
    }
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const card = charge?.payment_method_details?.card;
    Object.assign(meta, {
      stripe_status: pi.status,
      livemode: pi.livemode,
      card_brand: card?.brand ?? null,
      card_last4: card?.last4 ?? null,
      decline_code: pi.last_payment_error?.decline_code ?? null,
      error_code: pi.last_payment_error?.code ?? null,
    });
    if (pi.amount !== ctx.totalCents || pi.currency !== "eur") {
      return { status: "error", message: "Your basket changed. Please review your order and pay again.", metadata: { ...meta, card_result: "amount_mismatch", stripe_amount: pi.amount } };
    }
    switch (pi.status) {
      case "succeeded":
        consumedIntents.add(pi.id);
        return { status: "paid", metadata: { ...meta, card_result: "approved_stripe_test" } };
      case "processing":
        consumedIntents.add(pi.id);
        return { status: "pending", metadata: { ...meta, card_result: "processing_stripe_test" } };
      case "requires_action":
        return { status: "error", message: "Please complete the card authentication.", metadata: { ...meta, card_result: "requires_action" } };
      default: {
        const code = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code;
        if (code) return { status: "declined", message: DECLINE_MESSAGES[code] ?? "Your card was declined. Please try a different card.", metadata: { ...meta, card_result: "declined_stripe_test" } };
        return { status: "error", message: "Please complete your card details.", metadata: { ...meta, card_result: "incomplete" } };
      }
    }
  },
};

const ALL: Record<string, PaymentProvider> = {
  [stripeTestProvider.id]: stripeTestProvider,
  [testCardProvider.id]: testCardProvider,
  [bankTransferProvider.id]: bankTransferProvider,
};

/**
 * Enabled providers, in display order, from SHOP_PAYMENT_PROVIDERS. Default: stripe_test,bank_transfer
 * when Stripe test keys are configured, else test_card,bank_transfer. stripe_test is dropped
 * whenever the keys aren't test keys.
 */
export function enabledProviders(): PaymentProvider[] {
  const stripeReady = stripeTestConfig() !== null;
  const fallback = stripeReady ? "stripe_test,bank_transfer" : "test_card,bank_transfer";
  const ids = (process.env.SHOP_PAYMENT_PROVIDERS || fallback).split(",").map((s) => s.trim());
  return ids
    .filter((id) => id !== "stripe_test" || stripeReady)
    .map((id) => ALL[id])
    .filter((p): p is PaymentProvider => Boolean(p));
}

export function providerById(id: string): PaymentProvider | undefined {
  return enabledProviders().find((p) => p.id === id);
}
