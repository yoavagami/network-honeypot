import { withinWindow, type RecentRequest } from "../correlation/types.js";
import type { AlertMatch } from "./types.js";

const WINDOW_MS = 5 * 60_000;

/** "Access to sensitive-looking paths" — brief §36. Fires on the same recon-signature matches
 * that tag HONEYPOT_TRIGGER inline (docs/DETECTION.md §2) — this just escalates it to an alert. */
export function checkSensitivePathAccess(window: RecentRequest[], now: number): AlertMatch | null {
  const recent = withinWindow(window, now, WINDOW_MS).filter((r) => r.eventTypes.includes("HONEYPOT_TRIGGER"));
  if (recent.length === 0) return null;
  return {
    ruleId: "sensitive_path_access",
    severity: "high",
    title: "Sensitive-looking path accessed",
    description: `Accessed ${recent.length} recon-signature path(s) (e.g. .env, .git) in the last 5 minutes.`,
    metadata: { paths: [...new Set(recent.map((r) => r.path))].slice(0, 10) },
  };
}
