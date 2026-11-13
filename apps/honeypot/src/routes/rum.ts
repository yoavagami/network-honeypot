import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IngestionQueue } from "../ingestion/queue.js";
import { isBoundPageLoad } from "../sensing/pageLoads.js";

const MAX_BODY_CHARS = 64 * 1024;
const KINDS = new Set(["fp", "behavior", "probe"]);
const SDK_VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * Beacon endpoint for the fingerprint/behavior collector served as /assets/app.js
 * (static/app.js). Posted with navigator.sendBeacon as text/plain, so no CORS preflight; the
 * actor/session come from the same cookies every other request uses (ingestion/capture.ts).
 * Stored in client_signals; the request itself is also logged like any other.
 *
 * Every beacon is checked against the page it claims (sensing/pageLoads.ts): `bound` records
 * whether its page-load id was served to this visitor. Unbound beacons are kept for analysis but
 * the score leaves them out. A beacon carrying a known agent's DOM marker is proof-level evidence,
 * so it is queued high-priority (never the first thing dropped under load).
 */
export function registerRumRoutes(app: FastifyInstance, queue: IngestionQueue) {
  app.post("/api/v1/rum", async (request, reply) => {
    request.hp.endpoint = "site.rum";
    request.hp.applicationComponent = "telemetry";
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? null);
    if (!raw || raw.length > MAX_BODY_CHARS) return reply.status(204).send();

    let payload: { v?: unknown; sdk?: unknown; kind?: unknown; pl?: unknown; path?: unknown; t?: unknown; data?: unknown };
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply.status(204).send();
    }
    if (!payload || typeof payload.kind !== "string" || !KINDS.has(payload.kind) || typeof payload.data !== "object" || payload.data === null) {
      return reply.status(204).send();
    }
    if (request.hp.actorId) {
      const pageLoadId = typeof payload.pl === "string" ? payload.pl.slice(0, 40) : null;
      const bound = await isBoundPageLoad(pageLoadId, request.hp.actorId, request.hp.sessionId);
      const data = payload.data as Record<string, unknown>;
      queue.enqueue({
        kind: "client_signals",
        priority: carriesKnownArtifact(data) || (payload.kind === "probe" && Array.isArray(data.hits) && data.hits.length > 0) ? "high" : "low",
        row: {
          id: randomUUID(),
          createdAt: new Date(),
          actorId: request.hp.actorId,
          sessionId: request.hp.sessionId || null,
          visitorId: request.hp.visitorId || null,
          labLabel: request.hp.labLabel ?? null,
          labVerified: request.hp.labVerified ?? false,
          bound,
          schemaVersion: typeof payload.v === "number" && Number.isInteger(payload.v) && payload.v > 0 && payload.v < 100 ? payload.v : 1,
          sdkVersion: typeof payload.sdk === "string" && SDK_VERSION_RE.test(payload.sdk) ? payload.sdk : null,
          pageLoadId,
          kind: payload.kind,
          path: typeof payload.path === "string" ? payload.path.slice(0, 512) : null,
          data: { ...data, clientT: typeof payload.t === "number" ? payload.t : null },
        },
      });
    }
    return reply.status(204).send();
  });
}

/** A known agent's own UI element in the page (app.js KNOWN_ARTIFACTS) — proof of identity. */
export function carriesKnownArtifact(data: Record<string, unknown>): boolean {
  const arts = data.artifacts;
  return Array.isArray(arts) && arts.some((a) => a && typeof a === "object" && typeof (a as Record<string, unknown>).known === "string");
}
