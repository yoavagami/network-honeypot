import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";

export function registerCanaryRoutes(app: FastifyInstance) {
  app.get("/api/canaries", async (request, reply) => {
    const canaries = await db.select().from(schema.canaryObjects);
    const counts = await db
      .select({ canaryId: schema.canaryEvents.canaryId, count: sql<number>`count(*)::int` })
      .from(schema.canaryEvents)
      .groupBy(schema.canaryEvents.canaryId);
    const countMap = new Map(counts.map((c) => [c.canaryId, c.count]));

    reply.send({ data: canaries.map((c) => ({ ...c, triggerCount: countMap.get(c.canaryId) ?? 0 })) });
  });

  app.get("/api/canaries/:id/events", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const events = await db.select().from(schema.canaryEvents).where(eq(schema.canaryEvents.canaryId, id)).orderBy(desc(schema.canaryEvents.createdAt));
    reply.send({ data: events });
  });
}
