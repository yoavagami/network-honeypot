import { describe, it, expect } from "vitest";
import { detectReconnaissance } from "../src/rules/correlation/reconnaissance.js";
import { detectIdEnumeration, detectParameterEnumeration } from "../src/rules/correlation/enumeration.js";
import { detectFuzzing } from "../src/rules/correlation/fuzzing.js";
import { detectAuthProbing } from "../src/rules/correlation/authProbing.js";
import { detectApiProbing } from "../src/rules/correlation/apiProbing.js";
import { classifyScanner } from "../src/rules/correlation/scannerClassification.js";
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

describe("detectReconnaissance", () => {
  it("fires once 3+ distinct recon-signature paths are hit within the window", () => {
    const now = 1_000_000;
    const requests = [
      req({ atMs: now - 1000, path: "/.env", eventTypes: ["HONEYPOT_TRIGGER"] }),
      req({ atMs: now - 2000, path: "/.git/config", eventTypes: ["HONEYPOT_TRIGGER"] }),
      req({ atMs: now - 3000, path: "/wp-admin", eventTypes: ["HONEYPOT_TRIGGER"] }),
    ];
    expect(detectReconnaissance(requests, now)).not.toBeNull();
  });

  it("does not fire below the threshold", () => {
    const now = 1_000_000;
    const requests = [req({ atMs: now - 1000, path: "/.env", eventTypes: ["HONEYPOT_TRIGGER"] })];
    expect(detectReconnaissance(requests, now)).toBeNull();
  });

  it("ignores hits outside the time window", () => {
    const now = 1_000_000;
    const farPast = now - 10 * 60 * 1000;
    const requests = [
      req({ atMs: farPast, path: "/.env", eventTypes: ["HONEYPOT_TRIGGER"] }),
      req({ atMs: farPast, path: "/.git/config", eventTypes: ["HONEYPOT_TRIGGER"] }),
      req({ atMs: farPast, path: "/wp-admin", eventTypes: ["HONEYPOT_TRIGGER"] }),
    ];
    expect(detectReconnaissance(requests, now)).toBeNull();
  });
});

describe("detectIdEnumeration", () => {
  it("fires on 5+ distinct sequential IDs against the same path template", () => {
    const now = 1_000_000;
    const requests = [1, 2, 3, 4, 5].map((id) =>
      req({ atMs: now - id * 100, path: `/api/v1/users/${id}`, pathTemplate: "/api/v1/users/:id", pathParams: { id: String(id) } })
    );
    const result = detectIdEnumeration(requests, now);
    expect(result).not.toBeNull();
    expect(result?.evidence.sequential).toBe(true);
  });

  it("does not fire below the distinct-id threshold", () => {
    const now = 1_000_000;
    const requests = [1, 2].map((id) => req({ atMs: now - id * 100, pathTemplate: "/api/v1/users/:id", pathParams: { id: String(id) } }));
    expect(detectIdEnumeration(requests, now)).toBeNull();
  });
});

describe("detectParameterEnumeration", () => {
  it("fires on 8+ distinct values for the same query parameter", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 8 }, (_, i) =>
      req({ atMs: now - i * 10, path: "/search", queryParams: { category: String(i) } })
    );
    expect(detectParameterEnumeration(requests, now)).not.toBeNull();
  });
});

describe("detectFuzzing", () => {
  it("fires on 20+ distinct invalid paths within 2 minutes", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 20 }, (_, i) => req({ atMs: now - i * 100, path: `/x${i}`, eventTypes: ["INVALID_ROUTE"] }));
    expect(detectFuzzing(requests, now)).not.toBeNull();
  });

  it("does not fire for a handful of 404s", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 3 }, (_, i) => req({ atMs: now - i * 100, path: `/x${i}`, eventTypes: ["INVALID_ROUTE"] }));
    expect(detectFuzzing(requests, now)).toBeNull();
  });
});

describe("detectAuthProbing", () => {
  it("fires on login-failure velocity", () => {
    const now = 1_000_000;
    const events = Array.from({ length: 5 }, (_, i) => ({ atMs: now - i * 1000, eventType: "LOGIN_FAILURE" as const, username: "admin" }));
    const result = detectAuthProbing(events, now);
    expect(result).not.toBeNull();
    expect(result?.evidence.reasons).toContain("velocity");
  });

  it("fires on username enumeration even below velocity threshold", () => {
    const now = 1_000_000;
    const events = ["alice", "bob", "carol"].map((username, i) => ({ atMs: now - i * 1000, eventType: "LOGIN_FAILURE" as const, username }));
    const result = detectAuthProbing(events, now);
    expect(result).not.toBeNull();
    expect(result?.evidence.reasons).toContain("username_enumeration");
  });

  it("does not fire for a single failed login", () => {
    const now = 1_000_000;
    expect(detectAuthProbing([{ atMs: now, eventType: "LOGIN_FAILURE", username: "alice" }], now)).toBeNull();
  });
});

describe("detectApiProbing", () => {
  it("fires on malformed/unsupported-method API requests", () => {
    const now = 1_000_000;
    const requests = [req({ atMs: now - 100, path: "/api/v1/users", eventTypes: ["INVALID_METHOD"] })];
    expect(detectApiProbing(requests, now)).not.toBeNull();
  });

  it("fires on blind discovery (no /api/docs fetched first) once enough subpaths are hit", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 5 }, (_, i) => req({ atMs: now - i * 100, path: `/api/v1/resource${i}` }));
    const result = detectApiProbing(requests, now);
    expect(result).not.toBeNull();
    expect(result?.evidence.reasons).toContain("blind_discovery");
  });

  it("does not flag discovery that followed the documented path", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 5 }, (_, i) => req({ atMs: now - i * 100, path: `/api/v1/resource${i}`, fetchedDocsFirst: true }));
    expect(detectApiProbing(requests, now)).toBeNull();
  });
});

describe("classifyScanner", () => {
  it("returns null for a small handful of normal-looking requests", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 3 }, (_, i) => req({ atMs: now - i * 5000, path: "/" }));
    expect(classifyScanner(requests, now)).toBeNull();
  });

  it("raises confidence for scanner-UA + high rate + broad path coverage combined", () => {
    const now = 1_000_000;
    const requests = Array.from({ length: 30 }, (_, i) =>
      req({ atMs: now - i * 500, path: `/probe${i}`, userAgent: "python-requests/2.31" })
    );
    const result = classifyScanner(requests, now);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.3);
  });
});
