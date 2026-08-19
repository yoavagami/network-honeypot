import type { AlertMatch } from "./types.js";

export interface AuthFailureEvent {
  atMs: number;
  username?: string;
}

const WINDOW_MS = 10 * 60_000;

/** "More than N failed login attempts" — brief §36. A stricter escalation threshold than the
 * auth_probing *detection* (which fires at a lower bar to just tag the pattern) — this one is
 * meant to actually page someone, so it defaults higher. See docs/DETECTION.md §3. */
export function checkAuthFailureBurst(events: AuthFailureEvent[], now: number, threshold: number): AlertMatch | null {
  const recent = events.filter((e) => now - e.atMs <= WINDOW_MS);
  if (recent.length < threshold) return null;
  return {
    ruleId: "auth_failure_burst",
    severity: "critical",
    title: "Sustained authentication failures",
    description: `${recent.length} failed login attempts in the last 10 minutes (threshold: ${threshold}).`,
    metadata: { failureCount: recent.length, threshold },
  };
}
