import { describe, it, expect } from "vitest";
import { checkHighRequestRate } from "../src/rules/alerts/highRequestRate.js";
import { checkAuthFailureBurst } from "../src/rules/alerts/authFailureBurst.js";
import { checkLargeScaleEnumeration } from "../src/rules/alerts/largeScaleEnumeration.js";
import { checkSensitivePathAccess } from "../src/rules/alerts/sensitivePathAccess.js";
import { buildCanaryTriggeredAlert } from "../src/rules/alerts/canaryTriggered.js";
import type { RecentRequest } from "../src/rules/correlation/types.js";

function req(overrides: Partial<RecentRequest>): RecentRequest {
  return {
    atMs: 0,
    path: "/",
    pathTemplate: null,
    pathParams: {},
    method: "GET",
    statusCode: 200,
    userAgent: "Mozilla/5.0",
    eventTypes: [],
    queryParams: {},
    ...overrides,
  };
}

describe("checkHighRequestRate", () => {
  it("fires once requests in the last minute exceed the threshold", () => {
    const now = 1_000_000;
    const window = Array.from({ length: 101 }, (_, i) => req({ atMs: now - i * 100 }));
    const result = checkHighRequestRate(window, now, 100);
    expect(result?.ruleId).toBe("high_request_rate");
  });

  it("does not fire under the threshold", () => {
    const now = 1_000_000;
    const window = Array.from({ length: 5 }, (_, i) => req({ atMs: now - i * 100 }));
    expect(checkHighRequestRate(window, now, 100)).toBeNull();
  });
});

describe("checkAuthFailureBurst", () => {
  it("fires once failures in the window reach the threshold", () => {
    const now = 1_000_000;
    const events = Array.from({ length: 20 }, (_, i) => ({ atMs: now - i * 1000 }));
    expect(checkAuthFailureBurst(events, now, 20)?.ruleId).toBe("auth_failure_burst");
  });

  it("ignores failures outside the window", () => {
    const now = 1_000_000;
    const events = Array.from({ length: 20 }, () => ({ atMs: now - 20 * 60_000 }));
    expect(checkAuthFailureBurst(events, now, 20)).toBeNull();
  });
});

describe("checkLargeScaleEnumeration", () => {
  it("fires once distinct IDs against one path template reach the threshold", () => {
    const now = 1_000_000;
    const window = Array.from({ length: 50 }, (_, i) => req({ atMs: now - i * 10, pathTemplate: "/api/v1/users/:id", pathParams: { id: String(i) } }));
    expect(checkLargeScaleEnumeration(window, now, 50)?.ruleId).toBe("large_scale_enumeration");
  });

  it("does not fire below the threshold", () => {
    const now = 1_000_000;
    const window = Array.from({ length: 5 }, (_, i) => req({ atMs: now - i * 10, pathTemplate: "/api/v1/users/:id", pathParams: { id: String(i) } }));
    expect(checkLargeScaleEnumeration(window, now, 50)).toBeNull();
  });
});

describe("checkSensitivePathAccess", () => {
  it("fires on any recent HONEYPOT_TRIGGER", () => {
    const now = 1_000_000;
    const window = [req({ atMs: now - 100, path: "/.env", eventTypes: ["HONEYPOT_TRIGGER"] })];
    expect(checkSensitivePathAccess(window, now)?.ruleId).toBe("sensitive_path_access");
  });

  it("does not fire with no recon hits", () => {
    const now = 1_000_000;
    expect(checkSensitivePathAccess([req({ atMs: now })], now)).toBeNull();
  });
});

describe("buildCanaryTriggeredAlert", () => {
  it("always builds a critical alert and never leaks the full canary value", () => {
    const alert = buildCanaryTriggeredAlert("api_key", "GET /api/v1/config", "hp_pk_live_supersecretvalue123456");
    expect(alert.severity).toBe("critical");
    expect(JSON.stringify(alert)).not.toContain("supersecretvalue123456");
  });
});
