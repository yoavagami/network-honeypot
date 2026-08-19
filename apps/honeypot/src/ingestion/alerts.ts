import { randomUUID } from "node:crypto";
import {
  checkHighRequestRate,
  checkAuthFailureBurst,
  checkLargeScaleEnumeration,
  checkSensitivePathAccess,
  buildCanaryTriggeredAlert,
  deliverToAll,
  type AlertMatch,
  type AlertPayload,
} from "@honeypot/detection";
import type { EventType } from "@honeypot/types";
import type { Logger } from "@honeypot/logging";
import type { ObservedRequest } from "./recentBuffer.js";
import { config } from "../config.js";
import { buildAlertAdapters } from "./alertDelivery.js";
import type { IngestionQueue } from "./queue.js";

const adapters = buildAlertAdapters();

// Per (actor, rule) cooldown — an ongoing pattern (e.g. a sustained high request rate) would
// otherwise re-fire on every correlation tick. Canary reuse by the same actor shares this too
// (keyed per canary value), so a script hammering the same discovered key doesn't spam delivery
// — the underlying CANARY_TRIGGERED event/canary_events row is still recorded every time
// regardless; only alert *delivery* is throttled. See docs/ROADMAP.md Phase 2.
const cooldowns = new Map<string, number>();

function inCooldown(actorId: string, ruleId: string, now: number): boolean {
  const key = `${actorId}:${ruleId}`;
  const last = cooldowns.get(key);
  if (last !== undefined && now - last < config.alertCooldownMs) return true;
  cooldowns.set(key, now);
  return false;
}

async function fireAlert(actorId: string, match: AlertMatch, queue: IngestionQueue, logger: Logger) {
  const payload: AlertPayload = { ...match, actorId, triggeredAt: new Date().toISOString() };

  queue.enqueue({
    kind: "event",
    priority: "high",
    row: {
      eventId: randomUUID(),
      createdAt: new Date(),
      requestId: null,
      actorId,
      sessionId: null,
      eventType: "ALERT_TRIGGERED" satisfies EventType,
      severity: match.severity,
      riskScore: match.severity === "critical" ? 100 : 75,
      source: "correlation_worker",
      metadata: { ruleId: match.ruleId, title: match.title, description: match.description, ...match.metadata },
    },
  });

  if (adapters.length > 0) {
    const failures = await deliverToAll(adapters, payload);
    for (const f of failures) logger.warn({ msg: "alert delivery failed", adapter: f.adapter, ruleId: match.ruleId, error: f.error });
  }
}

export interface AuthFailureEvent {
  atMs: number;
  username?: string;
}

export async function evaluateWindowedAlerts(actorId: string, window: ObservedRequest[], authEvents: AuthFailureEvent[], now: number, queue: IngestionQueue, logger: Logger) {
  const matches = [
    checkHighRequestRate(window, now, config.alertThresholds.highRequestRatePerMinute),
    checkAuthFailureBurst(authEvents, now, config.alertThresholds.authFailureBurst),
    checkLargeScaleEnumeration(window, now, config.alertThresholds.largeScaleEnumeration),
    checkSensitivePathAccess(window, now),
  ].filter((m): m is AlertMatch => m !== null);

  for (const match of matches) {
    if (inCooldown(actorId, match.ruleId, now)) continue;
    await fireAlert(actorId, match, queue, logger);
  }
}

export async function fireCanaryAlert(actorId: string, canaryType: string, plantedLocation: string, value: string, queue: IngestionQueue, logger: Logger) {
  if (inCooldown(actorId, `canary_triggered:${value}`, Date.now())) return;
  const match = buildCanaryTriggeredAlert(canaryType, plantedLocation, value);
  await fireAlert(actorId, match, queue, logger);
}
