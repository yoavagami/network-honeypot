import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ID_PATTERNS } from "@honeypot/merchant-contract";
import { generateKey, displayKey, bearer, generateWebhookSecret } from "../src/keys.js";
import { signToken, verifyToken } from "../src/tokens.js";
import { newMerchantId, newAssessmentId, newEventId, visitIdFor } from "../src/ids.js";
import { encrypt, decrypt } from "../src/crypto.js";
import { signatureHeader, verifySignature } from "../src/webhooks/sign.js";
import { isPrivateAddress } from "../src/webhooks/http.js";
import { normaliseHost, verifyDomain } from "../src/domains.js";
import { buildTag, patchAppJs, PATCHES } from "../src/tag.js";
import { confidenceFor, decisionFor, policyCategory } from "../src/scoring/verdict.js";
import { normalisePath } from "../src/scoring/visits.js";

describe("identifiers and keys", () => {
  it("match the contract's formats", () => {
    for (let i = 0; i < 50; i++) {
      expect(newMerchantId()).toMatch(ID_PATTERNS.merchant);
      expect(newAssessmentId()).toMatch(ID_PATTERNS.assessment);
      expect(newEventId()).toMatch(ID_PATTERNS.event);
      expect(generateKey("public", false)).toMatch(ID_PATTERNS.siteKey);
      expect(generateKey("secret", true)).toMatch(ID_PATTERNS.secretKey);
      expect(generateWebhookSecret()).toMatch(ID_PATTERNS.webhookSecret);
    }
    expect(visitIdFor("mer_AAAAAAA1", "s_x_1")).toMatch(ID_PATTERNS.visit);
    expect(visitIdFor("mer_AAAAAAA1", "s_x_1")).toBe(visitIdFor("mer_AAAAAAA1", "s_x_1"));
    expect(visitIdFor("mer_AAAAAAA1", "s_x_1")).not.toBe(visitIdFor("mer_BBBBBBB2", "s_x_1"));
  });
  it("shows only a recognisable fragment of a key", () => {
    const k = generateKey("secret", false);
    expect(displayKey(k)).toBe(`${k.slice(0, 8)}…${k.slice(-4)}`);
    expect(displayKey(k)).not.toContain(k.slice(8, -4));
  });
  it("reads bearer tokens", () => {
    expect(bearer("Bearer sk_test_abc")).toBe("sk_test_abc");
    expect(bearer("Basic xyz")).toBeUndefined();
    expect(bearer(undefined)).toBeUndefined();
  });
});

describe("session tokens", () => {
  const secret = "s".repeat(40);
  it("round-trip and match the contract pattern", () => {
    const { token, claims } = signToken(secret, { m: "mer_AAAAAAA1", k: "k1", s: "sess", l: false });
    expect(token).toMatch(ID_PATTERNS.sessionToken);
    const v = verifyToken(secret, token);
    expect(v.ok && v.claims).toEqual(claims);
  });
  it("reject tampering, other secrets and expiry", () => {
    const { token } = signToken(secret, { m: "mer_AAAAAAA1", k: "k1", s: "sess", l: false });
    const [p, sig] = token.slice(3).split(".");
    const forged = Buffer.from(JSON.stringify({ m: "mer_BBBBBBB2", k: "k1", s: "sess", l: false, e: 9e9 })).toString("base64url");
    expect(verifyToken(secret, `st_${forged}.${sig}`)).toEqual({ ok: false, reason: "signature" });
    expect(verifyToken("o".repeat(40), token).ok).toBe(false);
    expect(verifyToken(secret, `st_${p}.${sig}`, Date.now() + 3 * 3600_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyToken(secret, "st_short.x").ok).toBe(false);
    expect(verifyToken(secret, undefined).ok).toBe(false);
  });
});

describe("crypto and webhook signatures", () => {
  const key = "a".repeat(64);
  it("encrypts webhook secrets at rest", () => {
    const blob = encrypt(key, "whsec_x");
    expect(blob).not.toContain("whsec_x");
    expect(decrypt(key, blob)).toBe("whsec_x");
    expect(() => decrypt("b".repeat(64), blob)).toThrow();
  });
  it("signs and verifies like the contract says", () => {
    const h = signatureHeader("whsec_s", '{"a":1}', 1000);
    expect(h).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
    expect(verifySignature("whsec_s", '{"a":1}', h, 1100)).toBe(true);
    expect(verifySignature("whsec_s", '{"a":2}', h, 1100)).toBe(false);
    expect(verifySignature("whsec_s", '{"a":1}', h, 1000 + 301)).toBe(false);
    expect(verifySignature("other", '{"a":1}', h, 1100)).toBe(false);
  });
});

describe("outbound safety", () => {
  it("treats private, loopback and link-local addresses as private", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.5", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("domains", () => {
  it("normalises hosts and refuses non-public ones", () => {
    expect(normaliseHost("https://Shop.Example.com/path?x=1")).toBe("shop.example.com");
    expect(normaliseHost("shop.example.com.")).toBe("shop.example.com");
    for (const bad of ["localhost", "10.0.0.1", "intranet", "x.local", "", "a..b.com"]) expect(normaliseHost(bad), bad).toBeNull();
  });
  it("verifies by DNS TXT or meta tag", async () => {
    expect(await verifyDomain("s.test", "tok", { resolveTxt: async () => [["uhoney-verify=tok"]], fetchHome: async () => "" })).toBe("dns");
    expect(await verifyDomain("s.test", "tok", { resolveTxt: async () => { throw new Error("none"); }, fetchHome: async () => '<head><meta name="uhoney-verify" content="tok"></head>' })).toBe("meta");
    expect(await verifyDomain("s.test", "tok", { resolveTxt: async () => [["uhoney-verify=other"]], fetchHome: async () => '<meta name="uhoney-verify" content="nope">' })).toBeNull();
  });
});

describe("tag", () => {
  const appJs = readFileSync(fileURLToPath(new URL("../../honeypot/static/app.js", import.meta.url)), "utf8");
  it("every patch target exists in the honeypot page script", () => {
    expect(() => patchAppJs(appJs)).not.toThrow();
  });
  it("points the page script at the merchant API and drops query strings", () => {
    const { body } = buildTag("https://api.example.test");
    expect(body).toContain('"https://api.example.test"');
    expect(body).not.toContain('"/api/v1/rum"');
    expect(body).not.toContain("location.pathname + location.search");
    expect(body).toContain("site_key: __UH.key");
    expect(body).toContain("lab: __UH.lab() || undefined");
    expect(body).toContain('get("lab")');
    for (const p of PATCHES) expect(body).toContain(p.replace);
  });
  it("is valid JavaScript", () => {
    const { body } = buildTag("https://api.example.test");
    expect(() => new Function(body)).not.toThrow();
  });
  it("fails loudly if app.js changes under a patch", () => {
    expect(() => patchAppJs(appJs.replace('var ENDPOINT = "/api/v1/rum";', 'var ENDPOINT = "/x";'))).toThrow(/endpoint/);
  });
});

describe("verdict mapping", () => {
  it("confidence bands", () => {
    expect(confidenceFor(0.97)).toBe("high");
    expect(confidenceFor(0.05)).toBe("high");
    expect(confidenceFor(0.8)).toBe("medium");
    expect(confidenceFor(0.5)).toBe("low");
  });
  it("decision: the policy's choice for the situation; the default never blocks", () => {
    const unverified = { driver: "agent" as const, agent: { id: "x", operator: null, verified: false, verification: null }, probability: 0.95, spoofed: false };
    const verified = { ...unverified, agent: { ...unverified.agent, verified: true, verification: "web_bot_auth" as const } };
    const human = { driver: "human" as const, agent: null, probability: 0.1, spoofed: false };
    expect(policyCategory(unverified)).toBe("unverified_agent");
    expect(policyCategory({ ...unverified, spoofed: true })).toBe("spoofed_agent");
    expect(policyCategory(verified)).toBe("verified_agent");
    expect(policyCategory({ ...unverified, driver: "agent_then_human" })).toBe("agent_then_human");
    expect(policyCategory({ driver: "unknown" as const, agent: null, probability: 0.5, spoofed: false })).toBe("uncertain");
    expect(policyCategory(human)).toBeNull();
    // Default policy.
    expect(decisionFor(unverified)).toBe("confirm");
    expect(decisionFor({ ...unverified, spoofed: true })).toBe("confirm");
    expect(decisionFor(verified)).toBe("allow");
    expect(decisionFor({ ...unverified, driver: "agent_then_human" })).toBe("allow");
    expect(decisionFor(human)).toBe("allow");
    // A merchant's choices win; situations it leaves unset use the default.
    expect(decisionFor({ ...unverified, spoofed: true }, { spoofed_agent: "block" })).toBe("block");
    expect(decisionFor(unverified, { spoofed_agent: "block" })).toBe("confirm");
    expect(decisionFor(unverified, { unverified_agent: "block" })).toBe("block");
    expect(decisionFor(verified, { unverified_agent: "block", verified_agent: "confirm" })).toBe("confirm");
    expect(decisionFor(human, { spoofed_agent: "block", unverified_agent: "block", uncertain: "block" })).toBe("allow");
  });
  it("normalises merchant paths", () => {
    expect(normalisePath("/checkout?email=a@b.c#x")).toBe("/checkout");
    expect(normalisePath("cart")).toBe("/cart");
    expect(normalisePath(null)).toBe("/");
  });
});
