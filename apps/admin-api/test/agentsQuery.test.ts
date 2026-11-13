import { describe, it, expect } from "vitest";
import { parseLabRunInput, toVisitListRow, whyMatcher } from "../src/agentsQuery.js";

describe("why filter", () => {
  it("matches text or signal ids with * and ? wildcards", () => {
    const reasons = [{ signal: "cursor_teleport", text: "cursor jumped straight onto 3 click targets" }, { signal: "residential_ip", text: "connects from KPN B.V." }];
    expect(whyMatcher("cursor_*", undefined)!(reasons)).toBe(true);
    expect(whyMatcher("KPN", "top")!(reasons)).toBe(true);
    expect(whyMatcher("tab*hidden", undefined)!(reasons)).toBe(false);
    expect(whyMatcher("  ", undefined)).toBeNull();
  });
  it("treats regex characters literally", () => {
    expect(whyMatcher("(.+)", undefined)!([{ signal: "x", text: "a (.+) b" }])).toBe(true);
    expect(whyMatcher("(.+)", undefined)!([{ signal: "x", text: "anything" }])).toBe(false);
  });
});

describe("lab run input", () => {
  it("accepts the naming convention", () => {
    expect(parseLabRunInput({ label: "claude-chrome-checkout-1", kind: "agent" })).toMatchObject({ ok: true, value: { label: "claude-chrome-checkout-1", ttlDays: 2 } });
    expect(parseLabRunInput({ label: "Human-Safari-3", kind: "human", ttlDays: 1 })).toMatchObject({ ok: true, value: { label: "human-safari-3", kind: "human" } });
  });
  it("rejects labels that break the convention or mix up kinds", () => {
    expect(parseLabRunInput({ label: "run1", kind: "agent" }).ok).toBe(false);
    expect(parseLabRunInput({ label: "human-chrome-1", kind: "agent" }).ok).toBe(false);
    expect(parseLabRunInput({ label: "browseruse-shop-1", kind: "human" }).ok).toBe(false);
    expect(parseLabRunInput({ label: "browseruse-shop-1", kind: "bot" }).ok).toBe(false);
    expect(parseLabRunInput({ label: "browseruse-shop-1", kind: "agent", ttlDays: 90 }).ok).toBe(false);
  });
});

describe("stored visit → list row", () => {
  it("keeps the list shape the dashboard renders", () => {
    const row = toVisitListRow({
      visit_id: "s_x_1", session_id: "x", actor_id: "a", first_at: "2026-11-13T10:00:00Z", last_at: "2026-11-13T10:05:00Z",
      request_count: 7, page_count: 3, lab_label: "human-chrome-1", lab_verified: true, probability: 0.12, bucket: "not_ai_agent", type: "human",
      agent: null, proven: false, reasons: [1, 2, 3, 4, 5, 6].map((i) => ({ signal: "s", group: "behavior", weight: -1, text: `r${i}` })),
      ip: "198.51.100.7", summary: { network: "KPN", checks: [{ id: "language", status: "match" }], shop: null }, scorer_version: "v", settled: true, computed_at: "2026-11-13T10:40:00Z",
    });
    expect(row.score.reasons).toHaveLength(4);
    expect(row.score.checks).toHaveLength(1);
    expect(row.labVerified).toBe(true);
    expect(row.lastAt).toBeInstanceOf(Date);
  });
});
