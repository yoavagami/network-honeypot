import { describe, it, expect } from "vitest";
import { computeTotals, addToCart, setQty } from "../src/shop/cart.js";
import { testCardProvider, bankTransferProvider, TEST_CARDS } from "../src/shop/payments.js";

describe("shop totals", () => {
  it("charges standard shipping under €40 and waives it above", () => {
    expect(computeTotals([{ sku: "HTH-250", qty: 1 }], "standard")).toMatchObject({ subtotalCents: 1150, shippingCents: 495, totalCents: 1645 });
    expect(computeTotals([{ sku: "HTH-500", qty: 2 }, { sku: "WRH-250", qty: 1 }], "standard")).toMatchObject({ subtotalCents: 4870, shippingCents: 0, totalCents: 4870 });
  });
  it("always charges express", () => {
    expect(computeTotals([{ sku: "HTH-500", qty: 2 }, { sku: "WRH-250", qty: 1 }], "express").totalCents).toBe(5865);
  });
  it("merges lines, caps quantity and removes at zero", () => {
    let lines = addToCart([], "WRH-250", 3);
    lines = addToCart(lines, "WRH-250", 9);
    expect(lines).toEqual([{ sku: "WRH-250", qty: 10 }]);
    expect(setQty(lines, "WRH-250", 0)).toEqual([]);
  });
});

describe("payment providers never accept real payment data", () => {
  it("approves only the browser's test-card result and keeps just the last four", () => {
    const r = testCardProvider.handle({ card_result: "approved_test", card_last4: "4242", card_brand: "visa" }, { totalCents: 1000 });
    expect(r.status).toBe("paid");
    expect(r.metadata.card_last4).toBe("4242");
  });
  it("declines a non-test card and records only its shape", () => {
    const r = testCardProvider.handle({ card_result: "rejected_non_test", card_number_length: "16", card_luhn_valid: "true" }, { totalCents: 1000 });
    expect(r.status).toBe("declined");
    expect(JSON.stringify(r.metadata)).not.toMatch(/\d{12,}/);
  });
  it("refuses a direct POST with no browser-side result", () => {
    expect(testCardProvider.handle({}, { totalCents: 1000 }).status).toBe("error");
  });
  it("bank transfer places the order as pending without asking for account details", () => {
    expect(bankTransferProvider.handle({}, { totalCents: 1000 }).status).toBe("pending");
    expect(bankTransferProvider.renderFields()).not.toMatch(/<input/);
  });
  it("only lists published test numbers", () => {
    for (const n of Object.keys(TEST_CARDS)) expect(n).toMatch(/^(4242|4000|5555|2223|3782)/);
  });
});

describe("stripe_test provider is test-mode only", () => {
  it("accepts only sk_test_/rk_test_ + pk_test_ keys", async () => {
    const { stripeTestConfig } = await import("../src/shop/stripeTest.js");
    expect(stripeTestConfig({})).toBeNull();
    expect(stripeTestConfig({ STRIPE_TEST_SECRET_KEY: "sk_live_abc", STRIPE_TEST_PUBLISHABLE_KEY: "pk_live_abc" })).toBeNull();
    expect(stripeTestConfig({ STRIPE_TEST_SECRET_KEY: "sk_test_abc", STRIPE_TEST_PUBLISHABLE_KEY: "pk_live_abc" })).toBeNull();
    expect(stripeTestConfig({ STRIPE_TEST_SECRET_KEY: "sk_live_abc", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_abc" })).toBeNull();
    expect(stripeTestConfig({ STRIPE_TEST_SECRET_KEY: "sk_test_abc", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_abc" })).not.toBeNull();
    expect(stripeTestConfig({ STRIPE_TEST_SECRET_KEY: "rk_test_abc", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_abc" })).not.toBeNull();
  });

  it("is never enabled with live keys, even if listed", async () => {
    const { enabledProviders } = await import("../src/shop/payments.js");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { SHOP_PAYMENT_PROVIDERS: "stripe_test,bank_transfer", STRIPE_TEST_SECRET_KEY: "sk_live_x", STRIPE_TEST_PUBLISHABLE_KEY: "pk_live_x" });
      expect(enabledProviders().map((p) => p.id)).toEqual(["bank_transfer"]);
      Object.assign(process.env, { STRIPE_TEST_SECRET_KEY: "sk_test_x", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_x" });
      expect(enabledProviders().map((p) => p.id)).toEqual(["stripe_test", "bank_transfer"]);
      delete process.env.SHOP_PAYMENT_PROVIDERS;
      expect(enabledProviders().map((p) => p.id)).toEqual(["stripe_test", "bank_transfer"]);
    } finally {
      process.env = saved;
    }
  });

  it("refuses a PaymentIntent that wasn't created for this checkout", async () => {
    const { stripeTestProvider } = await import("../src/shop/payments.js");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { STRIPE_TEST_SECRET_KEY: "sk_test_x", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_x" });
      const out = await stripeTestProvider.handle({ stripe_payment_intent: "pi_other" }, { totalCents: 1000, stripePaymentIntent: "pi_mine" });
      expect(out.status).toBe("error");
      expect(out.metadata.card_result).toBe("intent_mismatch");
      const empty = await stripeTestProvider.handle({ stripe_client_error: "incomplete_number" }, { totalCents: 1000, stripePaymentIntent: "pi_mine" });
      expect(empty.status).toBe("error");
      expect(empty.metadata.card_result).toBe("missing");
    } finally {
      process.env = saved;
    }
  });
});
