import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { audit } from "../audit.js";

export function registerActorRoutes(app: FastifyInstance) {
  app.get("/api/actors", async (request, reply) => {
    const q = request.query as { min_risk?: string; confidence?: string; q?: string; limit?: string };
    const limit = Math.min(200, Number(q.limit ?? 50));
    const conditions = [];
    if (q.min_risk) conditions.push(gte(schema.actors.riskScore, Number(q.min_risk)));
    if (q.confidence) conditions.push(eq(schema.actors.confidence, q.confidence));
    if (q.q) conditions.push(ilike(schema.actors.actorId, `%${q.q}%`));

    const rows = await db
      .select()
      .from(schema.actors)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.actors.lastSeenAt))
      .limit(limit);

    reply.send({ data: rows });
  });

  app.get("/api/actors/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [actor] = await db.select().from(schema.actors).where(eq(schema.actors.actorId, id)).limit(1);
    if (!actor) {
      reply.status(404).send({ error: { code: "not_found", message: "Actor not found" } });
      return;
    }
    const signals = await db.select().from(schema.actorSignals).where(eq(schema.actorSignals.actorId, id));
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.actorId, id));
    const detections = await db.select().from(schema.detections).where(eq(schema.detections.actorId, id));
    const canaryTriggerCount = (await db.select({ count: sql<number>`count(*)::int` }).from(schema.canaryEvents).where(eq(schema.canaryEvents.actorId, id)))[0]?.count ?? 0;

    const ipCount = new Set(signals.filter((s) => s.signalType === "ip_hash").map((s) => s.signalValue)).size;
    const userAgentCount = new Set(signals.filter((s) => s.signalType === "ua_fingerprint").map((s) => s.signalValue)).size;
    const authAttemptCount = detections.filter((d) => d.detectionType === "auth_probing").reduce((sum, d) => sum + d.eventCount, 0);
    const enumerationEventCount = detections.filter((d) => d.detectionType === "enumeration").reduce((sum, d) => sum + d.eventCount, 0);

    await audit(request.adminSession!.adminUserId, "view_actor", id, null);

    reply.send({
      ...actor,
      signals,
      sessionCount: sessions.length,
      ipCount,
      userAgentCount,
      canaryTriggerCount,
      authAttemptCount,
      enumerationEventCount,
      detections,
    });
  });

  app.get("/api/actors/:id/sessions", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.actorId, id)).orderBy(desc(schema.sessions.lastSeenAt));
    reply.send({ data: sessions });
  });

  app.get("/api/actors/:id/timeline", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [requests, events] = await Promise.all([
      db.select().from(schema.requests).where(eq(schema.requests.actorId, id)).orderBy(desc(schema.requests.createdAt)).limit(500),
      db.select().from(schema.events).where(eq(schema.events.actorId, id)).orderBy(desc(schema.events.createdAt)).limit(500),
    ]);

    const timeline = [
      ...requests.map((r) => ({
        at: r.createdAt,
        kind: "request" as const,
        label: `${r.method} ${r.path}`,
        method: r.method,
        path: r.path,
        statusCode: r.statusCode,
        eventType: null,
        severity: null,
        requestId: r.requestId,
        eventId: null,
      })),
      ...events
        .filter((e) => e.eventType !== "HTTP_REQUEST") // avoid duplicating the baseline event against its request row
        .map((e) => ({
          at: e.createdAt,
          kind: "event" as const,
          label: e.eventType,
          method: null,
          path: null,
          statusCode: null,
          eventType: e.eventType,
          severity: e.severity,
          requestId: e.requestId,
          eventId: e.eventId,
        })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    await audit(request.adminSession!.adminUserId, "view_actor_timeline", id, null);
    reply.send({ data: timeline });
  });
}
