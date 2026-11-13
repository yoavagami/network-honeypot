import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IngestionQueue } from "../ingestion/queue.js";
import "../context.js";

/**
 * Rendering ladder: tells "fetched the HTML only" from "rendered CSS, no JS" from "ran JS" on a
 * single page load. Scored in packages/detection/src/renderingLadder.ts.
 *
 * Every HTML response gets a fresh page-load id (saved as request_signals.data.pageLoadId) and three
 * beacons that carry it. They are served from ordinary-looking image paths so content blockers
 * leave them alone:
 *   /assets/img/bg/<id>.png  background-image of a visually hidden element: needs computed CSS
 *   /assets/img/px/<id>.gif  <img> inside <noscript>: fetched only when scripting is off
 *   /assets/img/sp/<id>.gif  requested by app.js as soon as it runs (it reads <meta name="request-id">)
 * Each hit is stored as a client_signals row of kind "ladder" with the id as page_load_id.
 *
 * The element is clipped rather than display:none, because browsers skip background images
 * of elements that generate no box.
 */

export const LADDER_ID_RE = /^[A-Za-z0-9_-]{16,40}$/;

const RUNGS = { bg: { rung: "css", ext: "png" }, px: { rung: "noscript", ext: "gif" }, sp: { rung: "js", ext: "gif" } } as const;

// 1×1 transparent images.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export function mintPageLoadId(): string {
  return randomBytes(15).toString("base64url");
}

/** Adds the ladder markup to a full HTML document. Returns null when it isn't one. */
export function injectLadder(html: string, id: string): string | null {
  const headEnd = html.search(/<\/head>/i);
  const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
  if (headEnd < 0 || bodyEnd < 0 || bodyEnd < headEnd) return null;
  const head =
    `<meta name="request-id" content="${id}" />\n` +
    `  <style>.vh-anchor{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);pointer-events:none;background:url(/assets/img/bg/${id}.png) no-repeat}</style>\n`;
  const body =
    `<span class="vh-anchor" aria-hidden="true"></span>` +
    `<noscript><img src="/assets/img/px/${id}.gif" alt="" width="1" height="1" style="position:absolute;left:-9999px" /></noscript>\n`;
  return html.slice(0, headEnd) + head + html.slice(headEnd, bodyEnd) + body + html.slice(bodyEnd);
}

/** onSend hook body: give every HTML document its page-load id and beacons. */
export function applyLadder(request: FastifyRequest, reply: FastifyReply, payload: unknown): unknown {
  if (typeof payload !== "string" || !request.hp || request.hp.skipIngestion) return payload;
  const type = String(reply.getHeader("content-type") ?? "");
  if (!type.startsWith("text/html")) return payload;
  const id = mintPageLoadId();
  const out = injectLadder(payload, id);
  if (out === null) return payload;
  request.hp.pageLoadId = id;
  return out;
}

export function registerLadderRoutes(app: FastifyInstance, queue: IngestionQueue) {
  for (const [dir, { rung, ext }] of Object.entries(RUNGS)) {
    app.get<{ Params: { file: string } }>(`/assets/img/${dir}/:file`, async (request, reply) => {
      request.hp.endpoint = "site.asset";
      request.hp.applicationComponent = "static";
      const id = request.params.file.endsWith(`.${ext}`) ? request.params.file.slice(0, -(ext.length + 1)) : "";
      if (!LADDER_ID_RE.test(id)) return reply.status(404).send();
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
            pageLoadId: id,
            kind: "ladder",
            path: null,
            data: { rung, referrer: typeof request.headers.referer === "string" ? request.headers.referer.slice(0, 512) : null },
          },
        });
      }
      reply.type(ext === "png" ? "image/png" : "image/gif").header("Cache-Control", "no-store").send(ext === "png" ? PNG : GIF);
    });
  }
}
