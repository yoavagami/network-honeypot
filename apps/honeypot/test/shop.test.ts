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
