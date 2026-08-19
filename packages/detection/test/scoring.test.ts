import { describe, it, expect } from "vitest";
import { computeEventRiskScore, computeActorRiskScore } from "../src/scoring.js";

describe("computeEventRiskScore", () => {
  it("sums weights and caps at 100", () => {
    expect(computeEventRiskScore([])).toBe(0);
    expect(computeEventRiskScore(["reconSignaturePath"])).toBe(15);
    expect(computeEventRiskScore(["canaryTriggered", "scannerDetectedHighConfidence"])).toBe(100);
  });
});

describe("computeActorRiskScore", () => {
  it("returns 0 for no events", () => {
    expect(computeActorRiskScore([])).toBe(0);
  });

  it("decays old high-risk events instead of pinning risk forever", () => {
    const halfLife = 1000 * 60 * 60 * 6;
    const freshScore = computeActorRiskScore([{ riskScore: 90, ageMs: 0 }], halfLife);
    const oldScore = computeActorRiskScore([{ riskScore: 90, ageMs: halfLife * 10 }], halfLife);
    expect(freshScore).toBe(90);
    expect(oldScore).toBeLessThan(5);
  });

  it("uses the max of decayed-max and decayed-average", () => {
    const halfLife = 1000 * 60 * 60 * 6;
    const score = computeActorRiskScore(
      [
        { riskScore: 10, ageMs: 0 },
        { riskScore: 90, ageMs: 0 },
      ],
      halfLife
    );
    expect(score).toBe(90);
  });
});
