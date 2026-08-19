import { withinWindow, type DetectionResult, type RecentRequest } from "./types.js";

const API_WINDOW_MS = 2 * 60 * 1000;
const DISTINCT_SUBPATH_THRESHOLD = 5;

/**
 * Unsupported methods, malformed JSON, invalid object IDs, or ≥5 distinct /api/* sub-paths
 * discovered within 2 minutes without ever having fetched /api/docs first.
 */
export function detectApiProbing(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, API_WINDOW_MS).filter((r) => r.path.startsWith("/api/"));
  if (window.length === 0) return null;

  const malformed = window.filter((r) => r.eventTypes.includes("API_ERROR") || r.eventTypes.includes("INVALID_METHOD"));
  const distinctSubpaths = new Set(window.map((r) => r.path));
  const fetchedDocsFirst = window.some((r) => r.fetchedDocsFirst);

  const blindDiscovery = distinctSubpaths.size >= DISTINCT_SUBPATH_THRESHOLD && !fetchedDocsFirst;
  if (malformed.length === 0 && !blindDiscovery) return null;

  const relevant = malformed.length > 0 ? malformed : window;
  const reasons = [malformed.length > 0 && "malformed_or_unsupported", blindDiscovery && "blind_discovery"].filter(Boolean);

  return {
    detectionType: "api_probing",
    confidence: Math.min(1, 0.5 + reasons.length * 0.2),
    evidence: { reasons, malformedCount: malformed.length, distinctSubpathCount: distinctSubpaths.size, fetchedDocsFirst },
    eventCount: relevant.length,
    firstEventAtMs: Math.min(...relevant.map((r) => r.atMs)),
    lastEventAtMs: Math.max(...relevant.map((r) => r.atMs)),
  };
}
