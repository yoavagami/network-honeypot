/**
 * Server-side identity checks, reused unchanged from the honeypot (apps/honeypot/src/sensing):
 * user-agent claims, Web Bot Auth signatures, operators' published agent IP ranges, Tor exits.
 * The merchant service runs them on the requests it sees — the tag's beacons and the visitor
 * request a merchant forwards on /v1/assess.
 */
import { createIpinfoProvider, type EnrichmentProvider } from "@honeypot/detection";
import { parseUserAgent } from "../../honeypot/src/sensing/userAgent.js";
import { verifyWebBotAuth, type WbaResult } from "../../honeypot/src/sensing/webBotAuth.js";
import { agentRangesFor, isTorExit, loadBundledRanges } from "../../honeypot/src/sensing/ipIntel.js";
import { decideIdentity } from "../../honeypot/src/sensing/verdict.js";
import { AGENTS } from "../../honeypot/src/sensing/agents.js";

let rangesLoaded = false;
export function ensureRangesLoaded() {
  if (rangesLoaded) return;
  loadBundledRanges();
  rangesLoaded = true;
}

export interface NetworkInfo { asn: string | null; organization: string | null; country: string | null }

export interface RequestIdentity {
  verdict: string;
  agent: string | null;
  method: string | null;
  reasons: string[];
  uaLibrary: string | null;
  aiApp: string | null;
  browserFamily: string | null;
  wbaStatus: string;
  wbaSigner: string | null;
  tor: boolean;
  ipRange: string | null;
  network: NetworkInfo | null;
}

export interface IdentifyInput {
  ip: string | null;
  userAgent: string | null;
  /** Lower-case header names. */
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  host?: string;
  /** Signature directory fetches can be slow; past this the signature counts as unverified for now. */
  wbaTimeoutMs?: number;
  network?: NetworkInfo | null;
}

export async function identifyRequest(i: IdentifyInput): Promise<RequestIdentity> {
  ensureRangesLoaded();
  const ua = parseUserAgent(i.userAgent);
  const headers = i.headers ?? {};
  const header = (name: string) => (headers[name] !== undefined ? [headers[name]!] : []);
  let wba: WbaResult = { status: "absent", signer: null };
  if (headers["signature"] || headers["signature-input"] || headers["signature-agent"]) {
    const timeout = new Promise<WbaResult>((r) => setTimeout(() => r({ status: "directory_unavailable", signer: null }), i.wbaTimeoutMs ?? 300).unref());
    wba = await Promise.race([
      verifyWebBotAuth({ method: i.method ?? "GET", url: i.path ?? "/", host: i.host ?? "", header }).catch((): WbaResult => ({ status: "directory_unavailable", signer: null })),
      timeout,
    ]);
  }
  const ipRanges = i.ip ? agentRangesFor(i.ip) : [];
  const identity = decideIdentity({ ua, rawUa: i.userAgent, ipRanges, rdns: null, wba, consistencyFlags: [] });
  return {
    verdict: identity.verdict,
    agent: identity.agent,
    method: identity.method,
    reasons: identity.reasons,
    uaLibrary: ua.library,
    aiApp: ua.aiApp,
    browserFamily: ua.browser?.family ?? null,
    wbaStatus: wba.status,
    wbaSigner: wba.signer,
    tor: i.ip ? isTorExit(i.ip) : false,
    ipRange: ipRanges[0] ?? null,
    network: i.network ?? null,
  };
}

/** Operators of agents that are detected in the page rather than by user-agent. */
const IN_PAGE_OPERATORS: Record<string, string> = {
  "claude-in-chrome": "Anthropic",
  "perplexity-comet": "Perplexity",
  "chatgpt-agent": "OpenAI",
  "chatgpt-atlas": "OpenAI",
  "browser-use": "Browser Use",
  manus: "Manus",
  stagehand: "Browserbase",
  skyvern: "Skyvern",
  magnitude: "Magnitude",
};
export function operatorFor(agentId: string | null): string | null {
  if (!agentId) return null;
  return AGENTS.find((a) => a.id === agentId)?.operator ?? IN_PAGE_OPERATORS[agentId] ?? null;
}

/** Optional ASN/organisation lookup (IPINFO_TOKEN), cached, never blocking for long. */
export class NetworkLookup {
  private cache = new Map<string, { at: number; value: NetworkInfo | null }>();
  constructor(private provider: EnrichmentProvider | null, private ttlMs = 24 * 3600_000, private max = 20_000) {}
  static fromEnv(env = process.env) {
    return new NetworkLookup(env.IPINFO_TOKEN ? createIpinfoProvider(env.IPINFO_TOKEN) : null);
  }
  cached(ip: string): NetworkInfo | null | undefined {
    const hit = this.cache.get(ip);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.value : undefined;
  }
  async lookup(ip: string | null, timeoutMs: number): Promise<NetworkInfo | null> {
    if (!ip || !this.provider) return null;
    const hit = this.cached(ip);
    if (hit !== undefined) return hit;
    const p = this.provider.lookup(ip).then((e) => (e ? { asn: e.asn, organization: e.organization, country: e.country } : null)).catch(() => null);
    const value = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref())]);
    // Cache late answers too, so the next beacon has it.
    void p.then((v) => this.store(ip, v));
    return value;
  }
  private store(ip: string, value: NetworkInfo | null) {
    if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(ip, { at: Date.now(), value });
  }
}
