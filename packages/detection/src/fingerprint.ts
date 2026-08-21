import { createHmac } from "node:crypto";

/**
 * HMAC-based IP hashing with a daily-rotating salt — retains correlation ability within a day
 * without keeping raw IPs indefinitely. See docs/DATA_MODEL.md §4.
 */
export function hashIp(ip: string, secret: string, dayKey: string = todayKey()): string {
  return createHmac("sha256", `${secret}:${dayKey}`).update(ip).digest("hex");
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

const IP_LIKE = /^[0-9a-fA-F.:]+$/;

/**
 * Resolves the actual visitor IP when there's more than one proxy hop between the client and
 * the app — found live on Render: `trustProxy: 1` (correct for the VPS/AWS path, which has
 * exactly one hop — our own Nginx) isn't enough there, because Render's public edge runs on
 * Cloudflare, and Cloudflare's own edge is functionally a *second* hop in front of Render's own
 * proxy. With trustProxy stuck at 1, Fastify's `request.ip` resolved to Cloudflare's edge
 * server address, not the visitor's — every request looked like it came from a handful of
 * Cloudflare colo IPs, geolocating to wherever that colo physically is (its result showed
 * Seattle/Amsterdam for real visitors from elsewhere), not the visitor's real location. Adding
 * more hops to `trustProxy` isn't a real fix either — Render doesn't publish exactly how many
 * internal hops sit between Cloudflare and the container, and that number could change without
 * notice. `CF-Connecting-IP` is Cloudflare's own answer to this exact problem: it's set by
 * Cloudflare's edge itself (overwriting anything the client sent), so it's trustworthy whenever
 * traffic is actually routed through Cloudflare — but NOT otherwise, since on a deployment with
 * no Cloudflare in front (VPS/AWS via our own Nginx), a client could set this header to anything
 * and there'd be nothing stripping it. That's why this only takes effect when
 * `trustCfConnectingIp` is explicitly true — wired to `TRUST_CF_CONNECTING_IP`, set only on the
 * Render deployment (see render.yaml), never as a default.
 */
export function resolveClientIp(fastifyIp: string, cfConnectingIpHeader: string | string[] | undefined, trustCfConnectingIp: boolean): string {
  if (!trustCfConnectingIp) return fastifyIp;
  const header = Array.isArray(cfConnectingIpHeader) ? cfConnectingIpHeader[0] : cfConnectingIpHeader;
  if (header && IP_LIKE.test(header)) return header;
  return fastifyIp;
}

/**
 * Coarse UA fingerprint: family + major version only (not the full raw string), so minor
 * version churn doesn't fragment actor correlation. The raw string is stored separately for
 * display.
 */
const UA_PATTERNS: Array<{ family: string; pattern: RegExp }> = [
  { family: "curl", pattern: /curl\/(\d+)/i },
  { family: "python-requests", pattern: /python-requests\/(\d+)/i },
  { family: "python-urllib", pattern: /python-urllib\/(\d+)/i },
  { family: "go-http-client", pattern: /go-http-client\/(\d+)/i },
  { family: "nikto", pattern: /nikto\/(\d+)/i },
  { family: "sqlmap", pattern: /sqlmap\/(\d+)/i },
  { family: "nuclei", pattern: /nuclei\/?(\d+)?/i },
  { family: "nmap", pattern: /nmap.*?(\d+)?/i },
  { family: "wget", pattern: /wget\/(\d+)/i },
  { family: "java", pattern: /java\/(\d+)/i },
  { family: "headless-chrome", pattern: /headlesschrome\/(\d+)/i },
  { family: "playwright", pattern: /playwright\/?(\d+)?/i },
  { family: "puppeteer", pattern: /puppeteer\/?(\d+)?/i },
  { family: "selenium", pattern: /selenium\/?(\d+)?/i },
  { family: "gptbot", pattern: /gptbot\/?(\d+)?/i },
  { family: "claudebot", pattern: /claudebot\/?(\d+)?/i },
  { family: "ccbot", pattern: /ccbot\/?(\d+)?/i },
  { family: "googlebot", pattern: /googlebot\/(\d+)/i },
  { family: "bingbot", pattern: /bingbot\/(\d+)/i },
  { family: "chrome", pattern: /chrome\/(\d+)/i },
  { family: "firefox", pattern: /firefox\/(\d+)/i },
  { family: "safari", pattern: /version\/(\d+).*safari/i },
  { family: "edge", pattern: /edg\/(\d+)/i },
];

export function userAgentFingerprint(userAgent: string | null | undefined): string {
  if (!userAgent) return "empty";
  for (const { family, pattern } of UA_PATTERNS) {
    const match = userAgent.match(pattern);
    if (match) return match[1] ? `${family}/${match[1]}` : family;
  }
  return "other";
}

export function tlsTuple(version: string | null, cipher: string | null, alpn: string | null): string {
  return [version ?? "?", cipher ?? "?", alpn ?? "?"].join("|");
}
