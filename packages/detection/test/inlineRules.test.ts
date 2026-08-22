import { describe, it, expect } from "vitest";
import { evaluateInline } from "../src/rules/inline/index.js";
import { matchesReconSignature } from "../src/rules/inline/reconSignatures.js";
import { matchesScannerUa } from "../src/rules/inline/scannerUa.js";
import { matchesDirectIpAccess } from "../src/rules/inline/directIpAccess.js";
import { findCanaryMatches } from "../src/rules/inline/canary.js";

describe("matchesReconSignature", () => {
  it("flags well-known recon paths", () => {
    expect(matchesReconSignature("/.env")).toBe(true);
    expect(matchesReconSignature("/.git/config")).toBe(true);
    expect(matchesReconSignature("/wp-admin/setup.php")).toBe(true);
  });

  it("does not flag normal application paths", () => {
    expect(matchesReconSignature("/api/v1/users")).toBe(false);
    expect(matchesReconSignature("/profile")).toBe(false);
  });
});

describe("matchesScannerUa", () => {
  it("flags known scanner/library substrings, case-insensitively", () => {
    expect(matchesScannerUa("curl/8.4.0")).toBe(true);
    expect(matchesScannerUa("python-requests/2.31")).toBe(true);
    expect(matchesScannerUa("Mozilla/5.0 sqlmap/1.7")).toBe(true);
  });

  it("does not flag an ordinary browser UA", () => {
    expect(matchesScannerUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36")).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(matchesScannerUa(null)).toBe(false);
    expect(matchesScannerUa(undefined)).toBe(false);
  });
});

describe("matchesDirectIpAccess", () => {
  it("flags a raw IPv4 Host header", () => {
    expect(matchesDirectIpAccess("54.213.42.101")).toBe(true);
  });

  it("flags a raw IPv4 Host header with a port", () => {
    expect(matchesDirectIpAccess("54.213.42.101:8080")).toBe(true);
  });

  it("flags a raw IPv6 Host header, bracketed and with a port", () => {
    expect(matchesDirectIpAccess("[2001:db8::1]:8080")).toBe(true);
    expect(matchesDirectIpAccess("2001:db8::1")).toBe(true);
  });

  it("does not flag a real hostname", () => {
    expect(matchesDirectIpAccess("www.mynewshop.io")).toBe(false);
    expect(matchesDirectIpAccess("honeypot-7t5a.onrender.com")).toBe(false);
    expect(matchesDirectIpAccess("localhost:8080")).toBe(false);
  });

  it("does not flag an out-of-range octet as an IP (rejects malformed input rather than guessing)", () => {
    expect(matchesDirectIpAccess("999.999.999.999")).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(matchesDirectIpAccess(null)).toBe(false);
    expect(matchesDirectIpAccess(undefined)).toBe(false);
    expect(matchesDirectIpAccess("")).toBe(false);
  });
});

describe("findCanaryMatches", () => {
  it("finds a planted canary value embedded anywhere in the haystacks", () => {
    const matches = findCanaryMatches(["Bearer hp_sk_live_abc123"], ["hp_sk_live_abc123"]);
    expect(matches).toEqual(["hp_sk_live_abc123"]);
  });

  it("returns empty when nothing matches", () => {
    expect(findCanaryMatches(["nothing here"], ["hp_sk_live_abc123"])).toEqual([]);
  });
});

describe("evaluateInline", () => {
  it("tags an unmatched route as INVALID_ROUTE with risk", () => {
    const result = evaluateInline({
      path: "/wp-login.php",
      method: "GET",
      routeMatched: false,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "curl/8.0",
      isAdminArea: false,
      hasRefererFromSite: false,
      candidateCanaryHaystacks: [],
      activeCanaryValues: [],
      host: "example.com",
    });
    expect(result.additionalEventTypes).toContain("INVALID_ROUTE");
    expect(result.riskFlags).toContain("invalidRouteOrMethodOrParam");
  });

  it("tags a canary match as CANARY_TRIGGERED regardless of other flags", () => {
    const result = evaluateInline({
      path: "/api/v1/config",
      method: "GET",
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "Mozilla/5.0",
      isAdminArea: false,
      hasRefererFromSite: true,
      candidateCanaryHaystacks: ["Authorization: Bearer hp_sk_live_deadbeef"],
      activeCanaryValues: ["hp_sk_live_deadbeef"],
      host: "example.com",
    });
    expect(result.additionalEventTypes).toContain("CANARY_TRIGGERED");
    expect(result.riskFlags).toContain("canaryTriggered");
    expect(result.canaryMatches).toEqual(["hp_sk_live_deadbeef"]);
  });

  it("flags direct admin access with no referer as higher risk than referred access", () => {
    const direct = evaluateInline({
      path: "/admin",
      method: "GET",
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "Mozilla/5.0",
      isAdminArea: true,
      hasRefererFromSite: false,
      candidateCanaryHaystacks: [],
      activeCanaryValues: [],
      host: "example.com",
    });
    const referred = evaluateInline({
      path: "/admin",
      method: "GET",
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "Mozilla/5.0",
      isAdminArea: true,
      hasRefererFromSite: true,
      candidateCanaryHaystacks: [],
      activeCanaryValues: [],
      host: "example.com",
    });
    expect(direct.riskFlags).toContain("adminPageDirectAccess");
    expect(referred.riskFlags).not.toContain("adminPageDirectAccess");
  });

  it("tags a request addressed by raw IP as DIRECT_IP_ACCESS", () => {
    const viaIp = evaluateInline({
      path: "/",
      method: "GET",
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "Mozilla/5.0",
      isAdminArea: false,
      hasRefererFromSite: false,
      candidateCanaryHaystacks: [],
      activeCanaryValues: [],
      host: "54.213.42.101",
    });
    const viaDomain = evaluateInline({
      path: "/",
      method: "GET",
      routeMatched: true,
      methodAllowed: true,
      paramValidationFailed: false,
      userAgent: "Mozilla/5.0",
      isAdminArea: false,
      hasRefererFromSite: false,
      candidateCanaryHaystacks: [],
      activeCanaryValues: [],
      host: "www.mynewshop.io",
    });
    expect(viaIp.additionalEventTypes).toContain("DIRECT_IP_ACCESS");
    expect(viaIp.riskFlags).toContain("directIpAccess");
    expect(viaDomain.additionalEventTypes).not.toContain("DIRECT_IP_ACCESS");
    expect(viaDomain.riskFlags).not.toContain("directIpAccess");
  });
});
