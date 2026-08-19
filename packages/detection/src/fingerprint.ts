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
