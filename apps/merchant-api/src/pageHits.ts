import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Deps } from "./context.js";
import { parseUserAgent } from "@honeypot/identity";
import { ALERT_PATHS, raiseAlert, type AlertKind } from "./siteAlerts.js";

/**
 * Records hits on the merchant platform's public pages, so admins can see who opened the
 * request-access page, the developer guide and the agent file (and which AI agents fetched it).
 * Written after the response is sent; a failure here never affects the page.
 */
const TRACKED = /^\/(merchants|docs\/integrate|integrate\/.+|llms\.txt)$/;

export function isTrackedPage(path: string) {
  return TRACKED.test(path);
}

function agentOf(ua: string | null) {
  const parsed = parseUserAgent(ua);
  return parsed.claim?.id ?? parsed.aiApp ?? parsed.library ?? (ua ? null : "no-user-agent");
}

export function registerPageHits(app: FastifyInstance, deps: Deps) {
  const alert = (request: FastifyRequest, kind: AlertKind, path: string, company: string | null) => {
    const ua = (request.headers["user-agent"] as string | undefined)?.slice(0, 512) ?? null;
    const ip = request.ip;
    return (async () => {
      const net = await deps.network.lookup(ip, 1000);
      await raiseAlert(deps.admin, deps.config.alerts, { kind, path, ip, country: net?.country ?? null, network: net?.organization ?? null, userAgent: ua, agent: agentOf(ua), company });
    })().catch((err) => request.log.warn({ msg: "site alert not recorded", err: String(err?.message ?? err) }));
  };
  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    // The request-access form: an alert only (the hit itself is the /merchants page view).
    if (request.method === "POST" && path === "/m/api/request-access") {
      if (reply.statusCode !== 202) return;
      const company = String((request.body as any)?.company ?? "").trim().slice(0, 120) || null;
      return void alert(request, "access_request", path, company);
    }
    if (request.method !== "GET" || !isTrackedPage(path)) return;
    const ua = (request.headers["user-agent"] as string | undefined)?.slice(0, 512) ?? null;
    const agent = agentOf(ua);
    const referrer = (request.headers.referer as string | undefined)?.slice(0, 512) ?? null;
    const ip = request.ip;
    void (async () => {
      const net = await deps.network.lookup(ip, 1000);
      await deps.admin`
        INSERT INTO public_page_hits (path, status, ip, country, network, user_agent, referrer, agent)
        VALUES (${path}, ${reply.statusCode}, ${ip}, ${net?.country ?? null}, ${net?.organization ?? null}, ${ua}, ${referrer}, ${agent})`;
      const kind = ALERT_PATHS[path];
      if (kind && reply.statusCode < 400) await raiseAlert(deps.admin, deps.config.alerts, { kind, path, ip, country: net?.country ?? null, network: net?.organization ?? null, userAgent: ua, agent });
    })().catch((err) => request.log.warn({ msg: "page hit not recorded", err: String(err?.message ?? err) }));
  });
}
