import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { schema } from "@honeypot/db";
import {
  detectReconnaissance,
  detectIdEnumeration,
  detectParameterEnumeration,
  detectFuzzing,
  detectAuthProbing,
  detectApiProbing,
  classifyScanner,
  computeActorRiskScore,
  type DetectionResult,
} from "@honeypot/detection";
import type { EventType } from "@honeypot/types";
import { db } from "../db.js";
import { config } from "../config.js";
import { recentBuffer } from "./recentBuffer.js";
import type { IngestionQueue } from "./queue.js";

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const DETECTION_EVENT_TYPE: Record<DetectionResult["detectionType"], EventType> = {
  reconnaissance: "HONEYPOT_TRIGGER",
  enumeration: "OBJECT_ENUMERATION",
  fuzzing: "FUZZING_DETECTED",
  scanner: "SCANNER_DETECTED",
  auth_probing: "AUTOMATION_DETECTED",
  api_probing: "API_ERROR",
  bot_classification: "BOT_DETECTED",
};

async function upsertDetection(actorId: string, result: DetectionResult) {
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const [existing] = await db
    .select({ detectionId: schema.detections.detectionId, eventCount: schema.detections.eventCount })
    .from(schema.detections)
    .where(
      and(
        eq(schema.detections.actorId, actorId),
        eq(schema.detections.detectionType, result.detectionType),
        gt(schema.detections.lastEventAt, since)
      )
    )
    .orderBy(desc(schema.detections.lastEventAt))
    .limit(1);

  if (existing) {
    await db
      .update(schema.detections)
      .set({
        lastEventAt: new Date(result.lastEventAtMs),
        eventCount: result.eventCount,
        confidence: String(result.confidence),
        evidence: result.evidence,
      })
      .where(eq(schema.detections.detectionId, existing.detectionId));
    return false; // not newly created — don't re-emit a fresh event for an ongoing pattern
  }

  await db.insert(schema.detections).values({
    detectionId: randomUUID(),
    actorId,
    detectionType: result.detectionType,
    confidence: String(result.confidence),
    evidence: result.evidence,
    firstEventAt: new Date(result.firstEventAtMs),
    lastEventAt: new Date(result.lastEventAtMs),
    eventCount: result.eventCount,
    acknowledged: false,
  });
  return true;
}

export function startCorrelationWorker(queue: IngestionQueue) {
  const timer = setInterval(() => void runCorrelationTick(queue), config.correlationIntervalMs);
  timer.unref();
  return timer;
}

export async function runCorrelationTick(queue: IngestionQueue) {
  const now = Date.now();
  recentBuffer.sweep(now);

  for (const actorId of recentBuffer.activeActorIds()) {
    const window = recentBuffer.get(actorId);
    if (window.length === 0) continue;

    const results = [
      detectReconnaissance(window, now),
      detectIdEnumeration(window, now),
      detectParameterEnumeration(window, now),
      detectFuzzing(window, now),
      detectApiProbing(window, now),
      classifyScanner(window, now),
      detectAuthProbing(
        window.filter((w) => w.authEventType).map((w) => ({ atMs: w.atMs, eventType: w.authEventType!, username: w.username })),
        now
      ),
    ].filter((r): r is DetectionResult => r !== null);

    for (const result of results) {
      const isNew = await upsertDetection(actorId, result);
      if (isNew) {
        queue.enqueue({
          kind: "event",
          priority: result.detectionType === "scanner" || result.detectionType === "auth_probing" ? "high" : "low",
          row: {
            eventId: randomUUID(),
            createdAt: new Date(),
            requestId: null,
            actorId,
            sessionId: null,
            eventType: DETECTION_EVENT_TYPE[result.detectionType],
            severity: result.confidence >= 0.7 ? "high" : "medium",
            riskScore: Math.round(result.confidence * 100),
            source: "correlation_worker",
            metadata: result.evidence,
          },
        });
      }
    }

    const riskScore = computeActorRiskScore(window.map((w) => ({ riskScore: w.riskScore, ageMs: now - w.atMs })));
    // Approximated from the in-memory correlation window (last ~15min), not a lifetime count —
    // cheap and sufficient for the dashboard; an all-time count would need a DB aggregate query.
    const uniquePaths = new Set(window.map((w) => w.path)).size;
    await db.update(schema.actors).set({ riskScore, uniquePaths }).where(eq(schema.actors.actorId, actorId));
  }
}
