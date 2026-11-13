import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SIGNALS, AI_SPECIFIC_SIGNALS, SCRIPT_ONLY_SIGNALS, signalCatalogue } from "../src/signals.js";

const scorerSrc = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/agentScore.ts"), "utf8");

describe("signal registry", () => {
  it("covers every signal the scorer emits, and nothing it doesn't", () => {
    const emitted = new Set([...scorerSrc.matchAll(/add\("(\w+)"/g)].map((m) => m[1]!));
    expect([...emitted].sort()).toEqual(Object.keys(SIGNALS).sort());
  });

  it("keeps the AI-specific and script-only sets the scorer had before the registry", () => {
    expect([...AI_SPECIFIC_SIGNALS].sort()).toEqual(["agent_like_dom", "ai_app_user_agent", "ai_operator_ip", "instant_checkout", "think_then_act", "unverifiable_claim"]);
    expect([...SCRIPT_ONLY_SIGNALS].sort()).toEqual(["beacon_unbound", "css_no_js", "html_only", "html_parser_images", "js_without_css", "no_javascript", "no_subresources"]);
  });

  it("describes every signal", () => {
    for (const s of signalCatalogue()) {
      expect(s.summary.length, s.id).toBeGreaterThan(10);
      expect(["identity", "driver", "environment", "journey"]).toContain(s.question);
    }
  });
});
