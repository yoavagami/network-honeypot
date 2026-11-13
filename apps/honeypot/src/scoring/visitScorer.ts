import type postgres from "postgres";
import { buildVisits, scoreVisit, visitEvidence, SCORER_VERSION, VISIT_GAP_MS } from "@honeypot/detection";
import { loadVisitRows } from "@honeypot/db";
import type { Logger } from "@honeypot/logging";
import { client } from "../db.js";
import { config } from "../config.js";
import { metrics } from "../ingestion/metrics.js";
import { visitScoreRow } from "./rows.js";

/**
 * Visit scoring worker (SDK_V2_IMPLEMENTATION_PLAN.md R2/R3). Scores visits once, as their data
 * arrives, and stores the verdict in visit_scores, so the dashboard reads an indexed table instead
 * of rescoring every request on every page view. The scorer itself stays pure
 * (packages/detection/src/agentScore.ts) — changing a weight means bumping SCORER_VERSION and
 * running `pnpm rescore`.
 *
 * Each tick rescoring the visits of every actor that:
 *   - sent a request or beacon since the last tick, or
 *   - has a visit that was scored before its rendering-ladder grace (30 s) had passed, or
 *   - has a visit that has now been quiet for the 30-minute visit gap (final, "settled" pass).
 *   - has a visit (in the 24 h lookback) scored by a different SCORER_VERSION, settled or not.
 * Older visits are only rescored by `pnpm rescore`, which deploy.sh runs *after* the new containers
 * are up — while an old worker is still running it would score them back to its own version.
 * Runs inside the honeypot process: honeypot_role already reads these tables for correlation,
 * and migration 0012 grants it write access to visit_scores/visit_requests only.
 */

/** How far back an actor's requests are loaded when its visits are rebuilt. */
export const SCORING_LOOKBACK_MS = 24 * 3600_000;
const MAX_ACTORS_PER_TICK = 500;
const ACTOR_CHUNK = 25;
const LADDER_GRACE_S = 35;

export interface ScoreActorsResult { visits: number; actors: number; truncatedActors: number }

/**
 * Rebuilds, scores and stores every visit of these actors that started after `since` (default:
 * the 24 h lookback). `now` is the wall clock: it decides ladder settling and `settled`.
 */
export async function scoreActors(sql: postgres.Sql, actorIds: string[], opts: { now?: Date; since?: Date } = {}): Promise<ScoreActorsResult> {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - SCORING_LOOKBACK_MS);
  let visits = 0;
  let truncatedActors = 0;
  for (let i = 0; i < actorIds.length; i += ACTOR_CHUNK) {
    const chunk = actorIds.slice(i, i + ACTOR_CHUNK);
    const rows = await loadVisitRows(sql, { since, until: new Date(now.getTime() + 60_000), actorIds: chunk, maxRequests: 50_000 });
    const built = buildVisits(rows.requests, rows.client, rows.shop);
    // This project's postgres client takes timestamps as ISO strings (see packages/db client config).
    const scoreRows = built.map((v) => {
      const r = visitScoreRow(v, scoreVisit(visitEvidence(v, now)), now);
      // drizzle replaces this client's JSON/array serializers with pass-through, so jsonb goes in
      // as JSON text and text[] as an array literal (signal ids are [a-z_]+, no quoting needed).
      return {
        ...r,
        computed_at: r.computed_at.toISOString(), first_at: r.first_at.toISOString(), last_at: r.last_at.toISOString(),
        signals: `{${r.signals.filter((x) => /^\w+$/.test(x)).join(",")}}`,
        reasons: JSON.stringify(r.reasons),
        summary: JSON.stringify(r.summary),
      };
    });
    const requestRows = built.flatMap((v) => v.requests.map((r) => ({ request_id: r.request_id, visit_id: v.id, created_at: r.created_at.toISOString() })));
    await sql.begin(async (tx) => {
      for (let j = 0; j < scoreRows.length; j += 500) {
        await tx`
          INSERT INTO visit_scores ${tx(scoreRows.slice(j, j + 500) as any[])}
          ON CONFLICT (visit_id) DO UPDATE SET
            scorer_version = EXCLUDED.scorer_version, computed_at = EXCLUDED.computed_at, settled = EXCLUDED.settled,
            session_id = EXCLUDED.session_id, last_at = EXCLUDED.last_at, request_count = EXCLUDED.request_count,
            page_count = EXCLUDED.page_count, lab_label = EXCLUDED.lab_label, lab_verified = EXCLUDED.lab_verified,
            probability = EXCLUDED.probability, bucket = EXCLUDED.bucket, type = EXCLUDED.type, agent = EXCLUDED.agent,
            proven = EXCLUDED.proven, signals = EXCLUDED.signals, reasons = EXCLUDED.reasons,
            ip = coalesce(EXCLUDED.ip, visit_scores.ip), summary = EXCLUDED.summary`;
      }
      for (let j = 0; j < requestRows.length; j += 2000) {
        await tx`
          INSERT INTO visit_requests ${tx(requestRows.slice(j, j + 2000))}
          ON CONFLICT (request_id) DO UPDATE SET visit_id = EXCLUDED.visit_id`;
      }
      // Visits can merge or split as new requests arrive (a one-request session that was folded
      // into an actor burst becomes a session visit once its second request lands). Drop rows for
      // ids that no longer exist — only when the whole window was loaded.
      if (!rows.truncated) {
        const ids = scoreRows.map((r) => r.visit_id);
        await tx`
          DELETE FROM visit_scores
          WHERE actor_id = ANY(${chunk}::uuid[]) AND first_at >= ${since.toISOString()}::timestamptz
            AND NOT (visit_id = ANY(${ids}::text[]))`;
      }
    });
    if (rows.truncated) truncatedActors += chunk.length;
    visits += scoreRows.length;
  }
  return { visits, actors: actorIds.length, truncatedActors };
}

/** Actors whose visits need (re)scoring this tick. */
export async function dirtyActors(sql: postgres.Sql, watermark: Date, limit = MAX_ACTORS_PER_TICK): Promise<string[]> {
  const wm = watermark.toISOString();
  const rows = await sql<{ actor_id: string }[]>`
    SELECT actor_id FROM (
      SELECT actor_id FROM request_signals WHERE created_at > ${wm}::timestamptz
      UNION
      SELECT actor_id FROM client_signals WHERE created_at > ${wm}::timestamptz
      UNION
      SELECT actor_id FROM visit_scores
      WHERE last_at > now() - make_interval(secs => ${SCORING_LOOKBACK_MS / 1000}) AND (
        -- scored by another scorer version: rescore even if settled, or a stale verdict sticks
        scorer_version <> ${SCORER_VERSION}
        OR (NOT settled AND (
          (computed_at < last_at + make_interval(secs => ${LADDER_GRACE_S}) AND now() > last_at + make_interval(secs => ${LADDER_GRACE_S}))
          OR now() > last_at + make_interval(secs => ${VISIT_GAP_MS / 1000})
        ))
      )
    ) dirty
    LIMIT ${limit}`;
  return rows.map((r) => r.actor_id);
}

export async function runScoringTick(sql: postgres.Sql, watermark: Date, logger: Logger): Promise<Date> {
  const tickStart = new Date();
  const actors = await dirtyActors(sql, watermark);
  if (!actors.length) return tickStart;
  const res = await scoreActors(sql, actors, { now: tickStart });
  metrics.visitsScoredTotal += res.visits;
  metrics.lastScoringAt = new Date().toISOString();
  metrics.scoringDurationMs = Date.now() - tickStart.getTime();
  if (res.truncatedActors) logger.warn({ msg: "visit scoring truncated", actors: res.truncatedActors });
  // Capped: some actors may be left — keep the old watermark so the next tick picks them up.
  // Upserts are idempotent, so re-scoring an actor twice is harmless.
  return actors.length >= MAX_ACTORS_PER_TICK ? watermark : new Date(tickStart.getTime() - 2_000);
}

export function startVisitScorer(logger: Logger) {
  // On boot, re-score anything that might still be open.
  let watermark = new Date(Date.now() - VISIT_GAP_MS - 60_000);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runScoringTick(client, watermark, logger)
      .then((wm) => { watermark = wm; })
      .catch((err) => {
        // Never let a scoring failure take the honeypot down (see the unhandled-rejection fix in
        // docs/ROADMAP.md Phase 4) — the next tick retries from the same watermark.
        metrics.scoringFailuresTotal += 1;
        logger.error({ msg: "visit scoring tick failed", err: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { running = false; });
  }, config.scorerIntervalMs);
  timer.unref();
}
