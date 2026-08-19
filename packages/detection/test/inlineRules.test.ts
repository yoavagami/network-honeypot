import { describe, it, expect } from "vitest";
import { evaluateInline } from "../src/rules/inline/index.js";
import { matchesReconSignature } from "../src/rules/inline/reconSignatures.js";
import { matchesScannerUa } from "../src/rules/inline/scannerUa.js";
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
    });
    expect(direct.riskFlags).toContain("adminPageDirectAccess");
    expect(referred.riskFlags).not.toContain("adminPageDirectAccess");
  });
});
