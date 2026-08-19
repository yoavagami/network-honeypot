import { deliverToAll, type AlertPayload } from "@honeypot/detection";
import type { Logger } from "@honeypot/logging";
import { config } from "../config.js";
import { buildAlertAdapters } from "./alertDelivery.js";
import { metrics } from "./metrics.js";
import type { IngestionQueue } from "./queue.js";

/**
 * Dead-man's-switch for the ingestion pipeline itself — see docs/ROADMAP.md Phase 4. Distinct
 * from the request-level alert rules in alerts.ts: those score *attacker behavior*; this scores
 * whether the platform is still able to record anything at all (e.g. Postgres unreachable). No
 * actor is involved, so this never writes an `events` row (events.actor_id is NOT NULL,
 * referencing a real observed actor) — it only reaches operators through the same webhook/
 * Slack/email delivery adapters, plus an always-on error-level log line as a last resort even
 * with no delivery target configured.
 */

const adapters = buildAlertAdapters();
const processStartedAtMs = Date.now();
let lastAlertFiredAtMs: number | null = null;
let requestsAtLastCheck = 0;

export function startHealthMonitor(queue: IngestionQueue, logger: Logger) {
  // See correlationWorker.ts's startCorrelationWorker for why this can't be a bare `void`.
  const timer = setInterval(() => {
    checkIngestionHealth(queue, logger).catch((err) => {
      logger.error({ msg: "ingestion health check itself failed", err: err instanceof Error ? err.message : String(err) });
    });
  }, config.healthCheckIntervalMs);
  timer.unref();
  return timer;
}

// Deliberately NOT keyed on current queue depth: queue.flush() splices items out of the queue
// *before* attempting the DB write (see queue.ts), so a failing insert drops them rather than
// leaving them queued — depth self-drains back toward 0 even while every flush is failing.
//
// Also deliberately NOT keyed on metrics.eventsReceivedTotal (only incremented once a row
// reaches queue.enqueue()): during a *total* outage, every request now fails actor resolution
// and gets dropped in capture.ts's finalizeRequest before ever reaching the queue — found live,
// this made eventsReceivedTotal stay flat through the exact scenario the switch exists to catch,
// so it never fired. metrics.requestsTotal increments unconditionally at the top of
// finalizeRequest, before that drop check, so it still tracks "is the app receiving traffic" even
// when nothing downstream of actor resolution is working.
function isIngestionStalled(requestsSinceLastCheck: number, nowMs: number): boolean {
  if (requestsSinceLastCheck === 0) return false; // no traffic since last check — not a failure
  const lastFlushMs = metrics.lastSuccessfulFlushAt ? new Date(metrics.lastSuccessfulFlushAt).getTime() : processStartedAtMs;
  return nowMs - lastFlushMs > config.ingestionStallThresholdMs;
}

export async function checkIngestionHealth(queue: IngestionQueue, logger: Logger) {
  const nowMs = Date.now();
  const requestsSinceLastCheck = metrics.requestsTotal - requestsAtLastCheck;
  requestsAtLastCheck = metrics.requestsTotal;

  if (!isIngestionStalled(requestsSinceLastCheck, nowMs)) return;
  if (lastAlertFiredAtMs !== null && nowMs - lastAlertFiredAtMs < config.alertCooldownMs) return;
  lastAlertFiredAtMs = nowMs;

  const payload: AlertPayload = {
    ruleId: "ingestion_stalled",
    severity: "critical",
    title: "Honeypot ingestion pipeline appears stalled",
    description: `Queue depth is ${queue.depth} with no successful DB flush in over ${Math.round(config.ingestionStallThresholdMs / 60_000)} minute(s). Requests/events may be silently dropped until this recovers.`,
    actorId: "system",
    metadata: {
      queueDepth: queue.depth,
      lastSuccessfulFlushAt: metrics.lastSuccessfulFlushAt,
      eventsReceivedTotal: metrics.eventsReceivedTotal,
      eventsProcessedTotal: metrics.eventsProcessedTotal,
      eventsDroppedTotal: metrics.eventsDroppedTotal,
      eventsFailedTotal: metrics.eventsFailedTotal,
    },
    triggeredAt: new Date(nowMs).toISOString(),
  };

  logger.error({ msg: "ingestion health check failed", ...payload });
  if (adapters.length > 0) {
    const failures = await deliverToAll(adapters, payload);
    for (const f of failures) logger.warn({ msg: "ingestion health alert delivery failed", adapter: f.adapter, error: f.error });
  }
}
