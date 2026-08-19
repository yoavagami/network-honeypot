import { describe, it, expect } from "vitest";
import { correlateActor } from "../src/actorCorrelation.js";

describe("correlateActor", () => {
  it("creates a new actor when there is no match at all", () => {
    const result = correlateActor(null, null);
    expect(result.action).toBe("create_new");
    expect(result.confidence).toBe("low");
  });

  it("prefers a visitor_id match over an ip+ua match when both exist", () => {
    const result = correlateActor(
      { actorId: "actor-visitor", matchedBy: "visitor_id", priorSessionCount: 1, hasConflictingSignals: false },
      { actorId: "actor-ipua", matchedBy: "ip_ua", priorSessionCount: 5, hasConflictingSignals: false }
    );
    expect(result.actorId).toBe("actor-visitor");
  });

  it("raises confidence to high once a visitor_id has persisted across multiple sessions", () => {
    const result = correlateActor(
      { actorId: "a1", matchedBy: "visitor_id", priorSessionCount: 2, hasConflictingSignals: false },
      null
    );
    expect(result.confidence).toBe("high");
  });

  it("downgrades confidence to low when signals conflict (shared egress / NAT)", () => {
    const result = correlateActor(null, { actorId: "a1", matchedBy: "ip_ua", priorSessionCount: 10, hasConflictingSignals: true });
    expect(result.confidence).toBe("low");
    expect(result.action).toBe("use_existing");
  });
});
