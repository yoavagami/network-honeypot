import { withinWindow, type RecentRequest } from "../correlation/types.js";
import type { AlertMatch } from "./types.js";

const WINDOW_MS = 60_000;

/** "More than N requests/minute from one actor" — brief §36. */
export function checkHighRequestRate(window: RecentRequest[], now: number, thresholdPerMinute: number): AlertMatch | null {
  const recent = withinWindow(window, now, WINDOW_MS);
  if (recent.length <= thresholdPerMinute) return null;
  return {
    ruleId: "high_request_rate",
    severity: "high",
    title: "High request rate from one actor",
    description: `${recent.length} requests in the last minute (threshold: ${thresholdPerMinute}/min).`,
    metadata: { requestsPerMinute: recent.length, thresholdPerMinute },
  };
}
