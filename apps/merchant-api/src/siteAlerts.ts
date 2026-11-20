import { BlockList, isIP } from "node:net";
import type { MerchantSql } from "@honeypot/merchant-db";

/**
 * Alerts on the public merchant pages: someone read the agent file or the developer guide, or sent
 * the request-access form. Each one is stored (admin dashboard → Merchants → Site alerts) and,
 * when MERCHANT_ALERT_URL is set, pushed there. Page reads: at most one alert per IP and kind every
 * 6 hours (every access request alerts; the form is rate-limited),
 * and none for the IPs in MERCHANT_ALERT_IGNORE_IPS (the team's own addresses).
 * Best-effort: nothing here ever affects the page that was served.
 */
export type AlertKind = "agent_file" | "developer_guide" | "access_request";

export const ALERT_PATHS: Record<string, AlertKind> = {
  "/integrate/v1/agent.md": "agent_file",
  "/docs/integrate": "developer_guide",
};

const TITLES: Record<AlertKind, string> = {
  agent_file: "Agent file read",
  developer_guide: "Developer guide opened",
  access_request: "New access request",
};

const DEDUPE_HOURS = 6;

export interface AlertConfig {
  /** Push target. Slack incoming webhooks get {text}; anything else (for example an ntfy topic URL) gets plain text. */
  url: string | undefined;
  ignore: BlockList;
  /** Where the alert links to (admin dashboard). */
  linkUrl: string;
}

/** "203.0.113.7, 198.51.100.0/24, 2001:db8::/32" → BlockList. Invalid entries throw at startup. */
export function parseIgnoreList(value: string | undefined): BlockList {
  const list = new BlockList();
  for (const raw of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = raw.split("/");
    const family = isIP(addr ?? "");
    if (!family) throw new Error(`MERCHANT_ALERT_IGNORE_IPS: "${raw}" is not an IP address or CIDR range`);
    const type = family === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(addr!, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) throw new Error(`MERCHANT_ALERT_IGNORE_IPS: bad prefix in "${raw}"`);
      list.addSubnet(addr!, prefix, type);
    }
  }
  return list;
}

function ignored(list: BlockList, ip: string) {
  const plain = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const family = isIP(plain);
  return family ? list.check(plain, family === 6 ? "ipv6" : "ipv4") : false;
}

export interface AlertInput {
  kind: AlertKind;
  path: string;
  ip: string;
  country: string | null;
  network: string | null;
  userAgent: string | null;
  agent: string | null;
  company?: string | null;
}

export function alertText(a: AlertInput, linkUrl: string) {
  const who = [a.ip, a.country, a.network, a.agent ?? (a.userAgent ? "browser" : "no user-agent")].filter(Boolean).join(" · ");
  const title = `uHoney: ${TITLES[a.kind]}${a.company ? ` - ${a.company}` : ""}`;
  return { title, body: `${who}\n${a.path}\n${linkUrl}` };
}

/** Slack control sequences (<!channel>, <url|text>) start with "<": the company name is visitor input. */
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Records the alert unless it's ignored or a duplicate, then pushes it. Returns whether one was recorded. */
export async function raiseAlert(sql: MerchantSql, cfg: AlertConfig, a: AlertInput, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (ignored(cfg.ignore, a.ip)) return false;
  const [row] = await sql<{ alert_id: string }[]>`
    INSERT INTO public_site_alerts (kind, path, ip, country, network, user_agent, agent, company)
    SELECT ${a.kind}, ${a.path}, ${a.ip}, ${a.country}, ${a.network}, ${a.userAgent}, ${a.agent}, ${a.company ?? null}
    WHERE ${a.kind} = 'access_request' OR NOT EXISTS (
      SELECT 1 FROM public_site_alerts
      WHERE ip = ${a.ip} AND kind = ${a.kind} AND created_at > now() - make_interval(hours => ${DEDUPE_HOURS}))
    RETURNING alert_id`;
  if (!row) return false;
  if (!cfg.url) return true;
  const { title, body } = alertText(a, cfg.linkUrl);
  try {
    const slack = new URL(cfg.url).hostname === "hooks.slack.com";
    const res = await fetchImpl(cfg.url, slack
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: slackEscape(`*${title}*\n${body}`) }), signal: AbortSignal.timeout(5000) }
      // ntfy-style: the body is the message, the Title header the headline.
      : { method: "POST", headers: { "content-type": "text/plain; charset=utf-8", title: title.replace(/[^\x20-\x7e]/g, "?"), tags: "honey_pot" }, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await sql`UPDATE public_site_alerts SET delivered_at = now() WHERE alert_id = ${row.alert_id}`;
  } catch (err: any) {
    await sql`UPDATE public_site_alerts SET delivery_error = ${String(err?.message ?? err).slice(0, 200)} WHERE alert_id = ${row.alert_id}`;
  }
  return true;
}
