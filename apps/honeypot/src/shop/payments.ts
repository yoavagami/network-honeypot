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
  handle(body: Record<string, unknown>, ctx: { totalCents: number }): PaymentOutcome;
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

const ALL: Record<string, PaymentProvider> = {
  [testCardProvider.id]: testCardProvider,
  [bankTransferProvider.id]: bankTransferProvider,
};

/** Enabled providers, in display order — SHOP_PAYMENT_PROVIDERS=test_card,bank_transfer (default). */
export function enabledProviders(): PaymentProvider[] {
  const ids = (process.env.SHOP_PAYMENT_PROVIDERS ?? "test_card,bank_transfer").split(",").map((s) => s.trim());
  return ids.map((id) => ALL[id]).filter((p): p is PaymentProvider => Boolean(p));
}

export function providerById(id: string): PaymentProvider | undefined {
  return enabledProviders().find((p) => p.id === id);
}
