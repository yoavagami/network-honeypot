import { promises as dns } from "node:dns";
import { outbound } from "./webhooks/http.js";

/** "https://Shop.Example.com/path" → "shop.example.com"; null if it isn't a plausible public host. */
export function normaliseHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes(".") || host.startsWith(".") || host.includes("..")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  return host;
}

export const VERIFY_PREFIX = "uhoney-verify=";

/**
 * Proves the merchant controls a host: a DNS TXT record "uhoney-verify=<token>" on the host, or
 * <meta name="uhoney-verify" content="<token>"> on its home page (fetched over https, public
 * addresses only, 256 KB cap).
 */
export async function verifyDomain(host: string, token: string, deps: { resolveTxt?: (h: string) => Promise<string[][]>; fetchHome?: (h: string) => Promise<string> } = {}): Promise<"dns" | "meta" | null> {
  const resolveTxt = deps.resolveTxt ?? ((h: string) => dns.resolveTxt(h));
  try {
    const records = await resolveTxt(host);
    if (records.some((parts) => parts.join("").trim() === `${VERIFY_PREFIX}${token}`)) return "dns";
  } catch { /* no TXT records */ }
  const fetchHome = deps.fetchHome ?? (async (h: string) => (await outbound({ url: `https://${h}/`, method: "GET", timeoutMs: 5000, maxBytes: 256 * 1024 })).body);
  try {
    const html = await fetchHome(host);
    const re = /<meta\s+[^>]*name=["']uhoney-verify["'][^>]*>/gi;
    for (const tag of html.match(re) ?? []) {
      const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
      if (content === token) return "meta";
    }
  } catch { /* unreachable */ }
  return null;
}
