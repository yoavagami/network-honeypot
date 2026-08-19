import type { AlertMatch } from "./types.js";

/** "Canary triggered" — brief §36. Not windowed like the other alert rules: canary use is
 * detected immediately at request time (docs/DETECTION.md §2), so this just builds the alert
 * payload for the caller to fire right away, every time, with no threshold. */
export function buildCanaryTriggeredAlert(canaryType: string, plantedLocation: string, value: string): AlertMatch {
  return {
    ruleId: "canary_triggered",
    severity: "critical",
    title: "Canary triggered",
    description: `A synthetic ${canaryType} planted at "${plantedLocation}" was used by a visitor.`,
    metadata: { canaryType, plantedLocation, canaryValuePreview: value.slice(0, 12) + "…" },
  };
}
