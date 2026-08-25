/**
 * Risk scoring weights — see docs/DETECTION.md §3. Plain constants, tunable without touching
 * ingestion/pipeline code.
 */
export const RISK_WEIGHTS = {
  scannerOrLibraryUa: 10,
  directIpAccess: 10,
  reconSignaturePath: 15,
  invalidRouteOrMethodOrParam: 20,
  enumerationDetected: 25,
  authProbingDetected: 25,
  apiProbingDetected: 30,
  adminPageDirectAccess: 35,
  scannerDetectedHighConfidence: 50,
  sqliProbe: 35,
  sqliConfirmed: 85,
  canaryTriggered: 90,
} as const;

export type RiskFlag = keyof typeof RISK_WEIGHTS;

export function computeEventRiskScore(flags: RiskFlag[]): number {
  const total = flags.reduce((sum, flag) => sum + RISK_WEIGHTS[flag], 0);
  return Math.min(100, total);
}

/**
 * Actor-level risk is a recency-weighted rollup, not a raw sum — a single old high-score event
 * should not permanently pin an actor at "critical" forever. Each event's contribution decays
 * exponentially with age; the actor score is the max of (decayed max, decayed recent average).
 */
export function computeActorRiskScore(
  events: Array<{ riskScore: number; ageMs: number }>,
  halfLifeMs = 1000 * 60 * 60 * 6 // 6 hours
): number {
  if (events.length === 0) return 0;
  const decayed = events.map((e) => e.riskScore * Math.pow(0.5, e.ageMs / halfLifeMs));
  const maxDecayed = Math.max(...decayed);
  const avgDecayed = decayed.reduce((a, b) => a + b, 0) / decayed.length;
  return Math.round(Math.min(100, Math.max(maxDecayed, avgDecayed)));
}
