import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { client } from "../db.js";

export function registerSystemRoutes(app: FastifyInstance) {
  app.get("/api/system/health", async (request, reply) => {
    let dbOk = true;
    try {
      await client`select 1`;
    } catch {
      dbOk = false;
    }
    reply.send({ status: dbOk ? "ok" : "degraded", components: { database: dbOk } });
  });

  // Reads the honeypot app's own ingestion health snapshot over the internal Docker network —
  // see docs/ARCHITECTURE.md §11 ("observability of the observability system").
  app.get("/api/system/ingestion", async (request, reply) => {
    try {
      const res = await fetch(`${config.honeypotInternalUrl}/internal/metrics`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`upstream status ${res.status}`);
      const metrics = await res.json();
      reply.send(metrics);
    } catch (err) {
      reply.status(503).send({ error: { code: "ingestion_unreachable", message: "Could not reach honeypot ingestion metrics" } });
    }
  });
}
