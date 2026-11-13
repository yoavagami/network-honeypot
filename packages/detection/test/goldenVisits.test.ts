import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scoreVisit, type VisitEvidence } from "../src/agentScore.js";

/**
 * Golden visits (SDK_V2_IMPLEMENTATION_PLAN.md E7): one JSON per known agent / human browser,
 * each with the verdict it must keep. `source: "lab-export"` fixtures are real lab visits exported
 * with `pnpm --filter @honeypot/app-honeypot export-fixture`; `synthetic` ones are hand-built from
 * cases seen live. A weight change that flips one of these must be deliberate.
 */
interface Fixture {
  name: string;
  source: "synthetic" | "lab-export";
  description: string;
  expect: { bucket: string; type?: string; proven?: boolean; agent?: string; signalsInclude?: string[]; signalsExclude?: string[] };
  evidence: VisitEvidence;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "visits");
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));

describe("golden visits", () => {
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(5));
  for (const f of fixtures) {
    it(`${f.name} (${f.source}) → ${f.expect.bucket}`, () => {
      const s = scoreVisit(f.evidence);
      const signals = s.reasons.map((r) => r.signal);
      const why = `${f.description}\n  got ${s.bucket} / ${s.type} p=${s.probability}: ${signals.join(", ")}`;
      expect(s.bucket, why).toBe(f.expect.bucket);
      if (f.expect.type) expect(s.type, why).toBe(f.expect.type);
      if (f.expect.proven !== undefined) expect(s.proven, why).toBe(f.expect.proven);
      if (f.expect.agent) expect(s.agent, why).toBe(f.expect.agent);
      for (const sig of f.expect.signalsInclude ?? []) expect(signals, why).toContain(sig);
      for (const sig of f.expect.signalsExclude ?? []) expect(signals, why).not.toContain(sig);
    });
  }
});
