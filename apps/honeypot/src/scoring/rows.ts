import { VISIT_GAP_MS, visitSummary, type AgentScore, type Visit } from "@honeypot/detection";

/**
 * Maps a scored visit to its visit_scores row (pure — unit-tested without a DB). `settled` means
 * the visit has been quiet for the visit gap, so no later request can join it and this score is
 * final for its SCORER_VERSION.
 */
export function visitScoreRow(v: Visit, score: AgentScore, now: Date) {
  const s = visitSummary(v, score);
  return {
    visit_id: v.id,
    scorer_version: score.scorerVersion,
    computed_at: now,
    settled: now.getTime() - s.lastAt.getTime() > VISIT_GAP_MS,
    actor_id: v.actorId,
    session_id: v.sessionId,
    first_at: s.firstAt,
    last_at: s.lastAt,
    request_count: s.requestCount,
    page_count: s.pageCount,
    lab_label: s.lab,
    lab_verified: s.labVerified,
    probability: score.probability,
    bucket: score.bucket,
    type: score.type,
    agent: score.agent,
    proven: score.proven,
    signals: [...new Set(score.reasons.map((r) => r.signal))],
    reasons: score.reasons,
    ip: s.ip,
    summary: {
      network: s.network,
      asn: s.asn,
      country: s.country,
      userAgent: s.userAgent,
      ja4: s.ja4,
      hasBrowserBeacon: s.hasBrowserBeacon,
      unboundBeacons: s.unboundBeacons,
      shop: s.shop,
      leaning: score.leaning,
      calibrated: score.calibrated,
      // Server-vs-page checks (a handful of rows) — the list's Checks column.
      checks: score.checks,
      // Who drove the visit (pageControl.ts) — the mode/handover only; the per-page table is
      // rebuilt on the visit page.
      control: { ...score.control, pages: [] },
    },
  };
}
export type VisitScoreRow = ReturnType<typeof visitScoreRow>;
