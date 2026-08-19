import { withinWindow, type DetectionResult, type RecentRequest } from "./types.js";

const FUZZ_WINDOW_MS = 2 * 60 * 1000;
const FUZZ_MIN_DISTINCT_INVALID = 20;

/** ≥20 distinct unmatched paths from one actor within 2 minutes. */
export function detectFuzzing(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, FUZZ_WINDOW_MS);
  const invalid = window.filter((r) => r.eventTypes.includes("INVALID_ROUTE"));
  const distinctPaths = new Set(invalid.map((r) => r.path));
  if (distinctPaths.size < FUZZ_MIN_DISTINCT_INVALID) return null;

  return {
    detectionType: "fuzzing",
    confidence: Math.min(1, 0.6 + distinctPaths.size * 0.01),
    evidence: { distinctInvalidPathCount: distinctPaths.size, windowMs: FUZZ_WINDOW_MS },
    eventCount: invalid.length,
    firstEventAtMs: Math.min(...invalid.map((r) => r.atMs)),
    lastEventAtMs: Math.max(...invalid.map((r) => r.atMs)),
  };
}
