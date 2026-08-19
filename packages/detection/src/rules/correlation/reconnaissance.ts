import { withinWindow, type DetectionResult, type RecentRequest } from "./types.js";

const RECON_WINDOW_MS = 5 * 60 * 1000;
const RECON_MIN_HITS = 3;

/** ≥3 distinct recon-signature-triggering paths from one actor within 5 minutes. */
export function detectReconnaissance(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, RECON_WINDOW_MS);
  const reconHits = window.filter((r) => r.eventTypes.includes("HONEYPOT_TRIGGER"));
  const distinctPaths = new Set(reconHits.map((r) => r.path));
  if (distinctPaths.size < RECON_MIN_HITS) return null;

  return {
    detectionType: "reconnaissance",
    confidence: Math.min(1, 0.5 + distinctPaths.size * 0.1),
    evidence: { distinctReconPaths: [...distinctPaths] },
    eventCount: reconHits.length,
    firstEventAtMs: Math.min(...reconHits.map((r) => r.atMs)),
    lastEventAtMs: Math.max(...reconHits.map((r) => r.atMs)),
  };
}
