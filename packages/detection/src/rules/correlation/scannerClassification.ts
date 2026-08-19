import { withinWindow, type DetectionResult, type RecentRequest } from "./types.js";
import { matchesScannerUa } from "../inline/scannerUa.js";

const SCANNER_WINDOW_MS = 60 * 1000;

/**
 * Weighted combination of signals — see docs/DETECTION.md §2. No single signal alone reaches
 * "high confidence"; this is deliberately a sum of weak signals, each capped in contribution.
 */
export function classifyScanner(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, SCANNER_WINDOW_MS);
  if (window.length < 5) return null;

  let score = 0;
  const signals: string[] = [];

  const scannerUaCount = window.filter((r) => matchesScannerUa(r.userAgent)).length;
  if (scannerUaCount / window.length > 0.8) {
    score += 0.25;
    signals.push("known-scanner-or-library-user-agent");
  }

  const requestsPerSecond = window.length / (SCANNER_WINDOW_MS / 1000);
  if (requestsPerSecond >= 3) {
    score += 0.2;
    signals.push(`high-request-rate:${requestsPerSecond.toFixed(1)}/s`);
  }

  const distinctPaths = new Set(window.map((r) => r.path)).size;
  if (distinctPaths >= window.length * 0.7 && distinctPaths >= 10) {
    score += 0.2;
    signals.push(`broad-unique-path-coverage:${distinctPaths}`);
  }

  const intervals = window
    .map((r) => r.atMs)
    .sort((a, b) => a - b)
    .slice(1)
    .map((t, i) => t - window.map((r) => r.atMs).sort((a, b) => a - b)[i]!);
  if (intervals.length >= 4) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    if (mean > 0 && stddev / mean < 0.3) {
      score += 0.2;
      signals.push("near-uniform-request-timing");
    }
  }

  const malformedRatio = window.filter((r) => r.eventTypes.some((t) => t.startsWith("INVALID_") || t === "API_ERROR")).length / window.length;
  if (malformedRatio > 0.3) {
    score += 0.15;
    signals.push(`malformed-request-ratio:${malformedRatio.toFixed(2)}`);
  }

  if (score < 0.3) return null;

  return {
    detectionType: "scanner",
    confidence: Math.min(1, score),
    evidence: { signals, requestsPerSecond, distinctPaths, malformedRatio },
    eventCount: window.length,
    firstEventAtMs: Math.min(...window.map((r) => r.atMs)),
    lastEventAtMs: Math.max(...window.map((r) => r.atMs)),
  };
}
