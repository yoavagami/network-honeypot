import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { audit } from "../audit.js";

export function registerDetectionRoutes(app: FastifyInstance) {
  app.get("/api/detections", async (request, reply) => {
    const q = request.query as { type?: string; acknowledged?: string; actor_id?: string; limit?: string };
    const conditions = [];
    if (q.type) conditions.push(eq(schema.detections.detectionType, q.type));
    if (q.acknowledged !== undefined) conditions.push(eq(schema.detections.acknowledged, q.acknowledged === "true"));
    if (q.actor_id) conditions.push(eq(schema.detections.actorId, q.actor_id));

    const rows = await db
      .select()
      .from(schema.detections)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.detections.lastEventAt))
      .limit(Math.min(200, Number(q.limit ?? 50)));

    reply.send({ data: rows });
  });

  app.post("/api/detections/:id/ack", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    await db
      .update(schema.detections)
      .set({ acknowledged: true, acknowledgedBy: request.adminSession!.username, acknowledgedAt: new Date() })
      .where(eq(schema.detections.detectionId, id));
    await audit(request.adminSession!.adminUserId, "ack_detection", id, null);
    reply.send({ ok: true });
  });
}
