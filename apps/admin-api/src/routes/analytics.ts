import type { FastifyInstance } from "fastify";
import { and, gte, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";

const RANGE_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function rangeStart(range: string | undefined, from: string | undefined): Date {
  if (from) return new Date(from);
  const ms = RANGE_MS[range ?? "24h"] ?? RANGE_MS["24h"]!;
  return new Date(Date.now() - ms);
}

export function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics/overview", async (request, reply) => {
    const q = request.query as { range?: string; from?: string; to?: string };
    const since = rangeStart(q.range, q.from);

    const [totals] = await db
      .select({
        totalRequests: sql<number>`count(*)::int`,
        uniqueActors: sql<number>`count(distinct actor_id)::int`,
        uniqueIps: sql<number>`count(distinct ip_hash)::int`,
        uniqueUserAgents: sql<number>`count(distinct user_agent_fingerprint)::int`,
        errorCount: sql<number>`count(*) filter (where status_code >= 400)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since));

    const methodBreakdown = await db
      .select({ method: schema.requests.method, count: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(schema.requests.method);

    const topEndpoints = await db
      .select({ path: schema.requests.path, count: sql<number>`count(*)::int` })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(schema.requests.path)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    const eventTypeCounts = await db
      .select({ eventType: schema.events.eventType, count: sql<number>`count(*)::int` })
      .from(schema.events)
      .where(gte(schema.events.createdAt, since))
      .groupBy(schema.events.eventType)
      .orderBy(sql`count(*) desc`);

    const [canaryTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.canaryEvents).where(gte(schema.canaryEvents.createdAt, since));
    const [detectionTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.detections).where(gte(schema.detections.lastEventAt, since));

    reply.send({
      range: { since: since.toISOString(), until: new Date().toISOString() },
      totals: totals ?? { totalRequests: 0, uniqueActors: 0, uniqueIps: 0, uniqueUserAgents: 0, errorCount: 0 },
      methodBreakdown,
      topEndpoints,
      eventTypeCounts,
      canaryTriggerCount: canaryTotal?.count ?? 0,
      detectionCount: detectionTotal?.count ?? 0,
    });
  });

  app.get("/api/analytics/traffic", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);
    const bucketMinutes = (RANGE_MS[q.range ?? "24h"] ?? RANGE_MS["24h"]!) > RANGE_MS["1h"]! ? 60 : 5;

    const rows = await db
      .select({
        bucket: sql<string>`date_trunc('hour', created_at) + floor(date_part('minute', created_at) / ${bucketMinutes}) * (${bucketMinutes} || ' minutes')::interval`,
        count: sql<number>`count(*)::int`,
        uniqueActors: sql<number>`count(distinct actor_id)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    reply.send({ data: rows });
  });

  app.get("/api/analytics/attacks", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const byType = await db
      .select({ detectionType: schema.detections.detectionType, count: sql<number>`count(*)::int` })
      .from(schema.detections)
      .where(gte(schema.detections.lastEventAt, since))
      .groupBy(schema.detections.detectionType);

    const riskBuckets = await db
      .select({
        bucket: sql<string>`case when risk_score >= 80 then 'critical' when risk_score >= 60 then 'high' when risk_score >= 35 then 'medium' when risk_score >= 15 then 'low' else 'info' end`,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.requests)
      .where(gte(schema.requests.createdAt, since))
      .groupBy(sql`1`);

    reply.send({ byDetectionType: byType, riskDistribution: riskBuckets });
  });

  app.get("/api/analytics/bots", async (request, reply) => {
    const q = request.query as { range?: string; from?: string };
    const since = rangeStart(q.range, q.from);

    const byUaFingerprint = await db
      .select({ uaFingerprint: schema.requests.userAgentFingerprint, count: sql<number>`count(*)::int`, uniqueActors: sql<number>`count(distinct actor_id)::int` })
      .from(schema.requests)
      .where(and(gte(schema.requests.createdAt, since)))
      .groupBy(schema.requests.userAgentFingerprint)
      .orderBy(sql`count(*) desc`)
      .limit(20);

    reply.send({ data: byUaFingerprint });
  });

  app.get("/api/analytics/first-contact", async (request, reply) => {
    const rows = await db
      .select({
        actorId: schema.actors.actorId,
        firstSeenAt: schema.actors.firstSeenAt,
      })
      .from(schema.actors)
      .orderBy(schema.actors.firstSeenAt)
      .limit(50);
    reply.send({ data: rows });
  });
}
