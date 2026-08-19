import { withinWindow, type DetectionResult } from "./types.js";

const AUTH_WINDOW_MS = 5 * 60 * 1000;
const RESET_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_VELOCITY_THRESHOLD = 5;
const USERNAME_ENUM_THRESHOLD = 3;
const RESET_THRESHOLD = 3;

export interface AuthEvent {
  atMs: number;
  eventType: "LOGIN_FAILURE" | "PASSWORD_RESET_ATTEMPT";
  username?: string;
}

/**
 * ≥5 LOGIN_FAILURE within 5 minutes (velocity), or ≥3 distinct usernames attempted
 * (enumeration), or ≥3 PASSWORD_RESET_ATTEMPT in 10 minutes.
 */
export function detectAuthProbing(events: AuthEvent[], nowMs: number): DetectionResult | null {
  const failures = events.filter((e) => e.eventType === "LOGIN_FAILURE" && nowMs - e.atMs <= AUTH_WINDOW_MS);
  const resets = events.filter((e) => e.eventType === "PASSWORD_RESET_ATTEMPT" && nowMs - e.atMs <= RESET_WINDOW_MS);
  const distinctUsernames = new Set(failures.map((e) => e.username).filter(Boolean));

  const velocityHit = failures.length >= FAILURE_VELOCITY_THRESHOLD;
  const enumHit = distinctUsernames.size >= USERNAME_ENUM_THRESHOLD;
  const resetHit = resets.length >= RESET_THRESHOLD;

  if (!velocityHit && !enumHit && !resetHit) return null;

  const relevant = velocityHit || enumHit ? failures : resets;
  const reasons = [velocityHit && "velocity", enumHit && "username_enumeration", resetHit && "reset_abuse"].filter(Boolean);

  return {
    detectionType: "auth_probing",
    confidence: Math.min(1, 0.5 + reasons.length * 0.2),
    evidence: {
      reasons,
      failureCount: failures.length,
      distinctUsernameCount: distinctUsernames.size,
      resetCount: resets.length,
    },
    eventCount: relevant.length,
    firstEventAtMs: Math.min(...relevant.map((e) => e.atMs)),
    lastEventAtMs: Math.max(...relevant.map((e) => e.atMs)),
  };
}
