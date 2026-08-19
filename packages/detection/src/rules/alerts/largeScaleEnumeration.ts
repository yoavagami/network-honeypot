import { withinWindow, type RecentRequest } from "../correlation/types.js";
import type { AlertMatch } from "./types.js";

const WINDOW_MS = 5 * 60_000;

/** "Large-scale enumeration" — brief §36. A higher bar than the enumeration *detection* rule
 * (docs/DETECTION.md §2, threshold 5) — this fires only once it's clearly not incidental. */
export function checkLargeScaleEnumeration(window: RecentRequest[], now: number, threshold: number): AlertMatch | null {
  const recent = withinWindow(window, now, WINDOW_MS).filter((r) => r.pathTemplate && r.pathParams.id !== undefined);
  const byTemplate = new Map<string, Set<string>>();
  for (const r of recent) {
    const set = byTemplate.get(r.pathTemplate!) ?? new Set<string>();
    set.add(r.pathParams.id!);
    byTemplate.set(r.pathTemplate!, set);
  }
  for (const [template, ids] of byTemplate) {
    if (ids.size >= threshold) {
      return {
        ruleId: "large_scale_enumeration",
        severity: "critical",
        title: "Large-scale ID enumeration",
        description: `${ids.size} distinct IDs enumerated against ${template} (threshold: ${threshold}).`,
        metadata: { pathTemplate: template, distinctIdCount: ids.size, threshold },
      };
    }
  }
  return null;
}
