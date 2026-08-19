import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, lte, lt } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { audit } from "../audit.js";

interface EventsQuery {
  from?: string;
  to?: string;
  event_type?: string;
  severity?: string;
  actor_id?: string;
  path?: string;
  cursor?: string;
  limit?: string;
}

export function registerEventRoutes(app: FastifyInstance) {
  app.get("/api/events", async (request, reply) => {
    const q = request.query as EventsQuery;
    const limit = Math.min(200, Number(q.limit ?? 50));
    const conditions = [];
    if (q.from) conditions.push(gte(schema.events.createdAt, new Date(q.from)));
    if (q.to) conditions.push(lte(schema.events.createdAt, new Date(q.to)));
    if (q.event_type) conditions.push(eq(schema.events.eventType, q.event_type));
    if (q.severity) conditions.push(eq(schema.events.severity, q.severity));
    if (q.actor_id) conditions.push(eq(schema.events.actorId, q.actor_id));
    if (q.cursor) conditions.push(lt(schema.events.createdAt, new Date(q.cursor)));

    const rows = await db
      .select()
      .from(schema.events)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.events.createdAt))
      .limit(limit);

    await audit(request.adminSession!.adminUserId, "list_events", null, null, { count: rows.length });
    reply.send({ data: rows, nextCursor: rows.length === limit ? rows[rows.length - 1]?.createdAt : null });
  });

  app.get("/api/events/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const [event] = await db.select().from(schema.events).where(eq(schema.events.eventId, id)).limit(1);
    if (!event) {
      reply.status(404).send({ error: { code: "not_found", message: "Event not found" } });
      return;
    }
    const request_ = event.requestId ? (await db.select().from(schema.requests).where(eq(schema.requests.requestId, event.requestId)).limit(1))[0] : null;
    const [actor] = await db.select().from(schema.actors).where(eq(schema.actors.actorId, event.actorId)).limit(1);

    await audit(request.adminSession!.adminUserId, "view_event", id, null);
    reply.send({ event, request: request_ ?? null, actor: actor ?? null });
  });
}
