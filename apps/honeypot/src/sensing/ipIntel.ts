import { BlockList, isIPv6 } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as dns } from "node:dns";
import type { Logger } from "@honeypot/logging";

/**
 * IP intelligence used by the identity verdict: which operator-published agent range an IP is in
 * (OpenAI, Anthropic, Google, Perplexity, Bing), Tor exit membership and forward-confirmed
 * reverse DNS. ASN / hosting provider comes from the existing per-actor ipinfo enrichment
 * (ingestion/enrichment.ts) and is joined at analysis time rather than looked up here.
 *
 * Ranges load from the bundled snapshot in data/ranges/ at startup, then refresh from the
 * operators' URLs every 12h — ChatGPT-User's list changes almost daily, a stale snapshot would
 * turn real traffic into "spoofed".
 */

const RANGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "ranges");

const RANGE_SOURCES: Record<string, string> = {
  "openai-gptbot": "https://openai.com/gptbot.json",
  "openai-searchbot": "https://openai.com/searchbot.json",
  "openai-chatgpt-user": "https://openai.com/chatgpt-user.json",
  "openai-adsbot": "https://openai.com/adsbot.json",
  "anthropic-bots": "https://claude.com/crawling/bots.json",
  "google-googlebot": "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
  "google-user-triggered-fetchers": "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json",
  "google-user-triggered-agents": "https://developers.google.com/static/search/apis/ipranges/user-triggered-agents.json",
  "perplexity-perplexitybot": "https://www.perplexity.com/perplexitybot.json",
  "perplexity-perplexity-user": "https://www.perplexity.com/perplexity-user.json",
  "bing-bingbot": "https://www.bing.com/toolbox/bingbot.json",
};
const TOR_EXIT_LIST_URL = "https://check.torproject.org/torbulkexitlist";

interface RangeFile {
  prefixes?: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }>;
}

const ranges = new Map<string, BlockList>();
let torExits = new Set<string>();

function toBlockList(data: RangeFile): BlockList {
  const list = new BlockList();
  for (const p of data.prefixes ?? []) {
    const cidr = p.ipv4Prefix ?? p.ipv6Prefix;
    if (!cidr) continue;
    const [net, bits] = cidr.split("/");
    try {
      list.addSubnet(net!, Number(bits), p.ipv6Prefix ? "ipv6" : "ipv4");
    } catch {
      // skip a malformed prefix rather than the whole file
    }
  }
  return list;
}

export function loadBundledRanges() {
  for (const file of readdirSync(RANGES_DIR)) {
    if (!file.endsWith(".json")) continue;
    ranges.set(file.replace(/\.json$/, ""), toBlockList(JSON.parse(readFileSync(path.join(RANGES_DIR, file), "utf8"))));
  }
}

async function refreshRanges(logger: Logger) {
  for (const [name, url] of Object.entries(RANGE_SOURCES)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; range-refresh)" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RangeFile;
      if (!data.prefixes?.length) throw new Error("no prefixes");
      ranges.set(name, toBlockList(data));
    } catch (err) {
      logger.warn({ msg: "agent range refresh failed, keeping previous list", range: name, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function refreshTor(logger: Logger) {
  try {
    const res = await fetch(TOR_EXIT_LIST_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const next = new Set(text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
    if (next.size > 100) torExits = next;
  } catch (err) {
    logger.warn({ msg: "tor exit list refresh failed", err: err instanceof Error ? err.message : String(err) });
  }
}

export function startIpIntelRefresh(logger: Logger) {
  loadBundledRanges();
  const run = () => {
    void refreshRanges(logger);
    void refreshTor(logger);
  };
  run();
  setInterval(() => void refreshRanges(logger), 12 * 3600_000).unref();
  setInterval(() => void refreshTor(logger), 6 * 3600_000).unref();
}

function normalize(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Names of every published agent range containing `ip`. */
export function agentRangesFor(ip: string): string[] {
  const addr = normalize(ip);
  const type = isIPv6(addr) ? "ipv6" : "ipv4";
  const hits: string[] = [];
  for (const [name, list] of ranges) {
    try {
      if (list.check(addr, type)) hits.push(name);
    } catch {
      // invalid address
    }
  }
  return hits;
}

export function isTorExit(ip: string): boolean {
  return torExits.has(normalize(ip));
}

export interface ReverseDns {
  ptr: string | null;
  /** True when the PTR hostname resolves back to the same IP — only then is the name trustworthy. */
  forwardConfirmed: boolean;
}

const rdnsCache = new Map<string, { at: number; value: ReverseDns }>();
const RDNS_TTL_MS = 24 * 3600_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref())]);
}

export async function reverseDns(ip: string): Promise<ReverseDns> {
  const addr = normalize(ip);
  const cached = rdnsCache.get(addr);
  if (cached && Date.now() - cached.at < RDNS_TTL_MS) return cached.value;
  let value: ReverseDns = { ptr: null, forwardConfirmed: false };
  try {
    const names = await withTimeout(dns.reverse(addr), 1500);
    const ptr = names[0] ?? null;
    if (ptr) {
      const forward = await withTimeout(isIPv6(addr) ? dns.resolve6(ptr) : dns.resolve4(ptr), 1500).catch(() => [] as string[]);
      value = { ptr, forwardConfirmed: forward.includes(addr) };
    }
  } catch {
    // no PTR / timeout — leave as null
  }
  if (rdnsCache.size > 20_000) rdnsCache.clear();
  rdnsCache.set(addr, { at: Date.now(), value });
  return value;
}
