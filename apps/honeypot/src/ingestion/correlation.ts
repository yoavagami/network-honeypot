import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { correlateActor, type ActorMatchCandidate } from "@honeypot/detection";
import { db } from "../db.js";

const RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResolveActorInput {
  visitorId: string;
  ipHash: string;
  uaFingerprint: string;
}

export interface ResolvedActor {
  actorId: string;
  confidence: "low" | "medium" | "high";
  isNewActor: boolean;
}

async function findVisitorIdCandidate(visitorId: string): Promise<ActorMatchCandidate | null> {
  const [signal] = await db
    .select({ actorId: schema.actorSignals.actorId })
    .from(schema.actorSignals)
    .where(and(eq(schema.actorSignals.signalType, "visitor_id"), eq(schema.actorSignals.signalValue, visitorId)))
    .limit(1);
  if (!signal) return null;

  const sessionCountRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.sessions)
    .where(eq(schema.sessions.actorId, signal.actorId));
  const priorSessionCount = sessionCountRows[0]?.count ?? 0;

  return { actorId: signal.actorId, matchedBy: "visitor_id", priorSessionCount, hasConflictingSignals: false };
}

async function findIpUaCandidate(ipHash: string, uaFingerprint: string): Promise<ActorMatchCandidate | null> {
  const since = new Date(Date.now() - RECENCY_WINDOW_MS);

  const ipRows = await db
    .select({ actorId: schema.actorSignals.actorId })
    .from(schema.actorSignals)
    .where(and(eq(schema.actorSignals.signalType, "ip_hash"), eq(schema.actorSignals.signalValue, ipHash), gt(schema.actorSignals.lastSeenAt, since)));
  if (ipRows.length === 0) return null;
  const ipActorIds = ipRows.map((r) => r.actorId);

  const uaRows = await db
    .select({ actorId: schema.actorSignals.actorId })
    .from(schema.actorSignals)
    .where(
      and(
        eq(schema.actorSignals.signalType, "ua_fingerprint"),
        eq(schema.actorSignals.signalValue, uaFingerprint),
        gt(schema.actorSignals.lastSeenAt, since),
        inArray(schema.actorSignals.actorId, ipActorIds)
      )
    );
  if (uaRows.length === 0) return null;
  const actorId = uaRows[0]!.actorId;

  // Heuristic: many distinct UAs behind the same ip_hash suggests shared egress (NAT/proxy),
  // not one consistent actor — flag it so correlation confidence is downgraded rather than
  // asserted. See docs/DETECTION.md §6.
  const distinctUaForIp = await db
    .select({ signalValue: schema.actorSignals.signalValue })
    .from(schema.actorSignals)
    .where(and(eq(schema.actorSignals.signalType, "ua_fingerprint"), inArray(schema.actorSignals.actorId, ipActorIds)));
  const hasConflictingSignals = new Set(distinctUaForIp.map((r) => r.signalValue)).size > 3;

  return { actorId, matchedBy: "ip_ua", priorSessionCount: 0, hasConflictingSignals };
}

async function upsertSignal(actorId: string, signalType: "visitor_id" | "ip_hash" | "ua_fingerprint" | "tls_tuple", signalValue: string) {
  await db
    .insert(schema.actorSignals)
    .values({ actorId, signalType, signalValue, firstSeenAt: new Date(), lastSeenAt: new Date(), occurrenceCount: 1 })
    .onConflictDoUpdate({
      target: [schema.actorSignals.actorId, schema.actorSignals.signalType, schema.actorSignals.signalValue],
      set: { lastSeenAt: new Date(), occurrenceCount: sql`${schema.actorSignals.occurrenceCount} + 1` },
    });
}

export async function resolveActor(input: ResolveActorInput): Promise<ResolvedActor> {
  const visitorIdMatch = await findVisitorIdCandidate(input.visitorId);
  const ipUaMatch = visitorIdMatch ? null : await findIpUaCandidate(input.ipHash, input.uaFingerprint);

  const decision = correlateActor(visitorIdMatch, ipUaMatch);

  let actorId: string;
  let isNewActor = false;

  if (decision.action === "create_new") {
    actorId = randomUUID();
    isNewActor = true;
    await db.insert(schema.actors).values({
      actorId,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      confidence: decision.confidence,
      riskScore: 0,
      totalRequests: 0,
      uniquePaths: 0,
    });
  } else {
    actorId = decision.actorId!;
    await db
      .update(schema.actors)
      .set({ lastSeenAt: new Date(), confidence: decision.confidence, totalRequests: sql`${schema.actors.totalRequests} + 1` })
      .where(eq(schema.actors.actorId, actorId));
  }

  await Promise.all([
    upsertSignal(actorId, "visitor_id", input.visitorId),
    upsertSignal(actorId, "ip_hash", input.ipHash),
    upsertSignal(actorId, "ua_fingerprint", input.uaFingerprint),
  ]);

  return { actorId, confidence: decision.confidence, isNewActor };
}

export async function resolveSession(
  actorId: string,
  sessionIdCookie: string | undefined,
  visitorId: string,
  ipHash: string,
  userAgentRaw: string | null,
  uaFingerprint: string
): Promise<string> {
  if (sessionIdCookie) {
    const [existing] = await db.select({ sessionId: schema.sessions.sessionId }).from(schema.sessions).where(eq(schema.sessions.sessionId, sessionIdCookie)).limit(1);
    if (existing) {
      await db.update(schema.sessions).set({ lastSeenAt: new Date() }).where(eq(schema.sessions.sessionId, sessionIdCookie));
      return existing.sessionId;
    }
  }
  const sessionId = randomUUID();
  await db.insert(schema.sessions).values({
    sessionId,
    actorId,
    visitorId,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    ipHash,
    userAgentRaw,
    userAgentFingerprint: uaFingerprint,
  });
  return sessionId;
}
