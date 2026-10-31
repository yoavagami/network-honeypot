import { AGENTS, SIGNING_PLATFORMS } from "./agents.js";
import type { UaInfo } from "./userAgent.js";
import type { WbaResult } from "./webBotAuth.js";
import type { ReverseDns } from "./ipIntel.js";

/**
 * Identity verdict for one request — "who does it claim to be, and can we prove or disprove it".
 *
 *   verified   claim proven: Web Bot Auth signature, operator IP list, or forward-confirmed rDNS
 *   spoofed    claim contradicted: bad signature, or IP outside the operator's published list
 *   claimed    claim made but the operator publishes no way to check it
 *   agent_ip   no claim, but the IP is inside an AI operator's published agent range
 *   automation an HTTP library / headless tool announcing itself (or no user-agent at all)
 *   ai_app     an AI assistant app / browser announcing itself (Claude desktop, Atlas favicon UA)
 *   browser_inconsistent  browser user-agent, but headers/TLS don't match that browser
 *   browser    nothing contradicts a normal browser (this includes undetected in-browser agents)
 */
export type Verdict =
  | "verified"
  | "spoofed"
  | "claimed"
  | "agent_ip"
  | "automation"
  | "ai_app"
  | "browser_inconsistent"
  | "browser";

export interface VerdictInput {
  ua: UaInfo;
  rawUa: string | null;
  ipRanges: string[];
  rdns: ReverseDns | null;
  wba: WbaResult;
  consistencyFlags: string[];
}

export interface VerdictResult {
  verdict: Verdict;
  agent: string | null;
  method: string | null;
  reasons: string[];
}

function signerAgent(signer: string): string {
  const agent = AGENTS.find((a) => a.signers?.includes(signer));
  if (agent) return agent.id;
  if (SIGNING_PLATFORMS[signer]) return SIGNING_PLATFORMS[signer]!;
  return `signer:${new URL(signer).hostname}`;
}

export function decideIdentity(i: VerdictInput): VerdictResult {
  const reasons: string[] = [];
  const { ua, wba } = i;

  // 1. A signature, when present, outranks everything else.
  if (wba.status === "verified" && wba.signer) {
    const agent = signerAgent(wba.signer);
    reasons.push(`Web Bot Auth signature verified for ${wba.signer} (keyid ${wba.keyid})`);
    if (ua.claim && ua.claim.id !== agent) reasons.push(`user-agent also claims ${ua.claim.id}`);
    return { verdict: "verified", agent, method: "web_bot_auth", reasons };
  }
  if (wba.status !== "absent" && wba.status !== "directory_unavailable") {
    const agent = wba.signer ? signerAgent(wba.signer) : ua.claim?.id ?? null;
    reasons.push(`Signature-Agent ${wba.signer ?? "(none)"} present but ${wba.status}${wba.error ? ` (${wba.error})` : ""}`);
    return { verdict: "spoofed", agent, method: "web_bot_auth", reasons };
  }
  if (wba.status === "directory_unavailable" && wba.signer) {
    reasons.push(`signed as ${wba.signer}, but its key directory could not be fetched`);
  }

  // 2. A user-agent claim, checked against what the operator publishes.
  if (ua.claim) {
    const claim = ua.claim;
    const own = claim.ranges ?? [];
    const hit = own.find((r) => i.ipRanges.includes(r));
    if (hit) {
      reasons.push(`user-agent claims ${claim.id}; IP is inside ${hit}.json`);
      return { verdict: "verified", agent: claim.id, method: "ip_range", reasons };
    }
    const ptr = i.rdns?.ptr ?? null;
    if (claim.rdnsSuffixes && ptr && i.rdns?.forwardConfirmed && claim.rdnsSuffixes.some((sfx) => ptr.endsWith(sfx))) {
      reasons.push(`user-agent claims ${claim.id}; reverse DNS ${ptr} forward-confirms`);
      return { verdict: "verified", agent: claim.id, method: "rdns", reasons };
    }
    if (own.length > 0 || claim.rdnsSuffixes) {
      const checks = [own.length ? `not in ${own.join(", ")}.json` : null, claim.rdnsSuffixes ? `rDNS ${ptr ?? "none"}${ptr && !i.rdns?.forwardConfirmed ? " (not forward-confirmed)" : ""}` : null].filter(Boolean);
      reasons.push(`user-agent claims ${claim.id} (${claim.operator}) but IP ${checks.join("; ")}`);
      if (i.ipRanges.length) reasons.push(`IP is inside ${i.ipRanges.join(", ")} instead`);
      return { verdict: "spoofed", agent: claim.id, method: own.length ? "ip_range" : "rdns", reasons };
    }
    reasons.push(`user-agent claims ${claim.id}; ${claim.operator} publishes no IP list or signature to verify it`);
    return { verdict: "claimed", agent: claim.id, method: null, reasons };
  }

  // 3. No claim, but the IP belongs to an AI operator's agent range.
  if (i.ipRanges.length > 0) {
    reasons.push(`no bot user-agent, but IP is inside ${i.ipRanges.join(", ")}.json`);
    return { verdict: "agent_ip", agent: i.ipRanges[0]!, method: "ip_range", reasons };
  }

  if (ua.library || !i.rawUa) {
    reasons.push(i.rawUa ? `user-agent is the ${ua.library} HTTP client` : "no user-agent header");
    return { verdict: "automation", agent: ua.library ?? "no-user-agent", method: "user_agent", reasons };
  }
  if (ua.aiApp) {
    reasons.push(`user-agent announces the ${ua.aiApp} app`);
    return { verdict: "ai_app", agent: ua.aiApp, method: "user_agent", reasons };
  }
  if (ua.browser && i.consistencyFlags.length > 0) {
    reasons.push(`${ua.browser.family} user-agent but: ${i.consistencyFlags.join(", ")}`);
    return { verdict: "browser_inconsistent", agent: null, method: "consistency", reasons };
  }
  if (!ua.browser) {
    reasons.push("non-browser user-agent with no known bot or library token");
    return { verdict: "automation", agent: "unknown-client", method: "user_agent", reasons };
  }
  reasons.push(`consistent ${ua.browser.family} ${ua.browser.major ?? ""}`.trim());
  return { verdict: "browser", agent: null, method: null, reasons };
}
