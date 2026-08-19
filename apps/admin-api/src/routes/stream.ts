import type { FastifyInstance } from "fastify";
import { gt, desc } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { config } from "../config.js";

/**
 * Server-Sent Events live feed — see docs/ARCHITECTURE.md (SSE chosen over WebSockets: this is
 * one-directional server→browser, which is all the live event stream needs). Implemented as a
 * short poll against Postgres rather than LISTEN/NOTIFY, to keep Phase 1 simple; the interface
 * to the browser (an SSE stream of event JSON) doesn't change if that's swapped out later.
 */
export function registerStreamRoute(app: FastifyInstance) {
  app.get("/api/stream", async (request, reply) => {
    reply.hijack(); // we're taking over the raw response for a long-lived SSE stream
    // hijack() bypasses Fastify's onSend hook chain, which is where @fastify/cors normally sets
    // CORS headers — without these set explicitly here, the browser's EventSource silently
    // rejects the stream as a cross-origin response with no CORS headers.
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": config.adminWebOrigin,
      "Access-Control-Allow-Credentials": "true",
    });

    let lastSeen = new Date();
    const interval = setInterval(() => {
      void (async () => {
        const rows = await db.select().from(schema.events).where(gt(schema.events.createdAt, lastSeen)).orderBy(desc(schema.events.createdAt)).limit(100);
        if (rows.length > 0) {
          lastSeen = rows[0]!.createdAt;
          for (const row of rows.reverse()) {
            reply.raw.write(`event: honeypot_event\ndata: ${JSON.stringify(row)}\n\n`);
          }
        } else {
          reply.raw.write(`: heartbeat\n\n`);
        }
      })().catch(() => {
        // connection likely closed; interval cleanup below handles it
      });
    }, 1000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });
}
