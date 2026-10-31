import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IngestionQueue } from "../ingestion/queue.js";

const MAX_BODY_CHARS = 64 * 1024;
const KINDS = new Set(["fp", "behavior"]);

/**
 * Beacon endpoint for the fingerprint/behavior collector served as /assets/app.js
 * (static/app.js). Posted with navigator.sendBeacon as text/plain, so no CORS preflight; the
 * actor/session come from the same cookies every other request uses (ingestion/capture.ts).
 * Stored in client_signals; the request itself is also logged like any other.
 */
export function registerRumRoutes(app: FastifyInstance, queue: IngestionQueue) {
  app.post("/api/v1/rum", async (request, reply) => {
    request.hp.endpoint = "site.rum";
    request.hp.applicationComponent = "telemetry";
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? null);
    if (!raw || raw.length > MAX_BODY_CHARS) return reply.status(204).send();

    let payload: { kind?: unknown; pl?: unknown; path?: unknown; t?: unknown; data?: unknown };
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply.status(204).send();
    }
    if (!payload || typeof payload.kind !== "string" || !KINDS.has(payload.kind) || typeof payload.data !== "object" || payload.data === null) {
      return reply.status(204).send();
    }
    if (request.hp.actorId) {
      queue.enqueue({
        kind: "client_signals",
        priority: "low",
        row: {
          id: randomUUID(),
          createdAt: new Date(),
          actorId: request.hp.actorId,
          sessionId: request.hp.sessionId || null,
          visitorId: request.hp.visitorId || null,
          labLabel: request.hp.labLabel ?? null,
          pageLoadId: typeof payload.pl === "string" ? payload.pl.slice(0, 40) : null,
          kind: payload.kind,
          path: typeof payload.path === "string" ? payload.path.slice(0, 512) : null,
          data: { ...(payload.data as Record<string, unknown>), clientT: typeof payload.t === "number" ? payload.t : null },
        },
      });
    }
    return reply.status(204).send();
  });
}
