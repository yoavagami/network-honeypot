import type { ActorConfidence } from "@honeypot/types";

export interface ActorMatchCandidate {
  actorId: string;
  matchedBy: "visitor_id" | "ip_ua";
  /** How many distinct sessions/visitor_ids have been observed for this actor so far. */
  priorSessionCount: number;
  /** Whether this candidate's history shows the same ip_hash paired with wildly different UAs. */
  hasConflictingSignals: boolean;
}

export interface ActorCorrelationResult {
  action: "use_existing" | "create_new";
  actorId?: string;
  confidence: ActorConfidence;
}

/**
 * Pure decision function — see docs/DETECTION.md §6. The DB lookups that produce
 * `ActorMatchCandidate` live in the honeypot app; this function only decides given the
 * candidates found.
 */
export function correlateActor(
  visitorIdMatch: ActorMatchCandidate | null,
  ipUaMatch: ActorMatchCandidate | null
): ActorCorrelationResult {
  const match = visitorIdMatch ?? ipUaMatch;
  if (!match) {
    return { action: "create_new", confidence: "low" };
  }

  let confidence: ActorConfidence;
  if (match.hasConflictingSignals) {
    confidence = "low";
  } else if (match.matchedBy === "visitor_id" && match.priorSessionCount >= 2) {
    confidence = "high";
  } else if (match.matchedBy === "visitor_id") {
    confidence = "medium";
  } else {
    confidence = "medium";
  }

  return { action: "use_existing", actorId: match.actorId, confidence };
}
