import type { FastifyInstance } from "fastify";
import type { Deps } from "./context.js";
import { parseUserAgent } from "../../honeypot/src/sensing/userAgent.js";

/**
 * Records hits on the merchant platform's public pages, so admins can see who opened the
 * request-access page, the developer guide and the agent file (and which AI agents fetched it).
 * Written after the response is sent; a failure here never affects the page.
 */
const TRACKED = /^\/(merchants|docs\/integrate|integrate\/.+|llms\.txt)$/;

export function isTrackedPage(path: string) {
  return TRACKED.test(path);
}

export function registerPageHits(app: FastifyInstance, deps: Deps) {
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (request.method !== "GET" || !isTrackedPage(path)) return;
    const ua = (request.headers["user-agent"] as string | undefined)?.slice(0, 512) ?? null;
    const parsed = parseUserAgent(ua);
    const agent = parsed.claim?.id ?? parsed.aiApp ?? parsed.library ?? (ua ? null : "no-user-agent");
    const referrer = (request.headers.referer as string | undefined)?.slice(0, 512) ?? null;
    const ip = request.ip;
    void (async () => {
      const net = await deps.network.lookup(ip, 1000);
      await deps.admin`
        INSERT INTO public_page_hits (path, status, ip, country, network, user_agent, referrer, agent)
        VALUES (${path}, ${reply.statusCode}, ${ip}, ${net?.country ?? null}, ${net?.organization ?? null}, ${ua}, ${referrer}, ${agent})`;
    })().catch((err) => request.log.warn({ msg: "page hit not recorded", err: String(err?.message ?? err) }));
  });
}
