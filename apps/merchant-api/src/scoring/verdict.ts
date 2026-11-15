import { scoreVisit, visitEvidence, SIGNALS, type AgentScore, type Visit } from "@honeypot/detection";
import {
  DEFAULT_POLICY, SERVER_REASON_CODES, AUTOMATION_TYPES,
  type AgentInfo, type Confidence, type Driver, type Policy, type Reason, type SuggestedAction, type VerificationMethod,
} from "@honeypot/merchant-contract";
import { operatorFor } from "../sensing.js";

/**
 * Maps the scorer's verdict (packages/detection AgentScore) to the merchant contract's fields:
 * driver, agent, confidence, reasons and the policy's suggested action. Pure.
 */

export interface MerchantVerdict {
  score: AgentScore;
  driver: Driver;
  handover: { page: string | null; at: string | null } | null;
  automationType: (typeof AUTOMATION_TYPES)[number];
  agent: AgentInfo | null;
  probability: number;
  confidence: Confidence;
  reasons: Reason[];
  signalsUsed: { client: boolean; server: boolean };
}

const AGENTISH_MODES = new Set(["agent", "agent_then_human", "human_then_agent", "mixed"]);

export function driverFor(score: AgentScore, hasClient: boolean): Driver {
  const mode = score.control.mode;
  if (AGENTISH_MODES.has(mode)) return mode as Driver;
  if (mode === "human") return score.probability >= 0.7 ? "agent" : "human";
  if (score.probability >= 0.7) return "agent";
  if (score.probability < 0.35 && hasClient) return "human";
  return "unknown";
}

export function confidenceFor(p: number): Confidence {
  if (p >= 0.9 || p <= 0.1) return "high";
  if (p >= 0.75 || p <= 0.25) return "medium";
  return "low";
}

const VERIFICATION: Record<string, VerificationMethod> = { web_bot_auth: "web_bot_auth", ip_range: "published_ip_range", rdns: "reverse_dns" };

function verificationFor(visit: Visit, agent: string | null): VerificationMethod | null {
  const verified = visit.requests.find((r) => r.identity_verdict === "verified" && (!agent || r.identity_agent === agent));
  return verified?.verdict_method ? VERIFICATION[verified.verdict_method] ?? null : null;
}

/** Signals that describe the visit without weighing on the score, but matter to a merchant. */
const INFORMATIVE = new Set(["handover_agent_to_human", "handover_human_to_agent", "mixed_control"]);

export function reasonsFor(score: AgentScore, extra: Array<keyof typeof SERVER_REASON_CODES>): Reason[] {
  const leaningAgent = score.probability >= 0.5;
  const scored = score.reasons
    .filter((r) => INFORMATIVE.has(r.signal) || (leaningAgent ? r.weight > 0 : r.weight < 0))
    .sort((a, b) => Number(INFORMATIVE.has(b.signal)) - Number(INFORMATIVE.has(a.signal)) || Math.abs(b.weight) - Math.abs(a.weight));
  const seen = new Set<string>();
  const out: Reason[] = extra.map((code) => ({ code, text: SERVER_REASON_CODES[code] }));
  for (const r of scored) {
    if (seen.has(r.signal) || !(r.signal in SIGNALS)) continue;
    seen.add(r.signal);
    out.push({ code: r.signal, text: r.text });
  }
  return out.slice(0, 8);
}

export function verdictFor(visit: Visit, now: Date, extra: Array<keyof typeof SERVER_REASON_CODES> = []): MerchantVerdict {
  const score = scoreVisit(visitEvidence(visit, now));
  const hasClient = visit.client.some((c) => c.kind === "fp" || c.kind === "behavior");
  const reasonsExtra = [...extra];
  if (!hasClient && !reasonsExtra.includes("no_client_signals")) reasonsExtra.unshift("no_client_signals");
  if (visit.requests.some((r) => r.wba_status !== "absent" && r.wba_status !== "verified")) reasonsExtra.push("web_bot_auth_unverified");
  const driver = driverFor(score, hasClient);
  const agentish = score.probability >= 0.35 || driver !== "human";
  const automationType = score.probability < 0.35 && !AGENTISH_MODES.has(score.control.mode) ? (hasClient ? "human" : "unknown") : score.type;
  const agent: AgentInfo | null = score.agent && agentish
    ? { id: score.agent, operator: operatorFor(score.agent), verified: score.proven, verification: score.proven ? verificationFor(visit, score.agent) : null }
    : null;
  const h = score.control.handover;
  return {
    score,
    driver,
    handover: h ? { page: h.path, at: h.at } : null,
    automationType,
    agent,
    probability: Math.round(score.probability * 1000) / 1000,
    confidence: confidenceFor(score.probability),
    reasons: reasonsFor(score, reasonsExtra),
    signalsUsed: { client: hasClient, server: visit.requests.length > 0 },
  };
}

/** The merchant's policy decides the suggestion; anything unset falls back to the default policy. */
export function suggestedAction(v: Pick<MerchantVerdict, "driver" | "agent" | "probability">, policy: Partial<Policy> = {}): SuggestedAction {
  const p = { ...DEFAULT_POLICY, ...policy };
  if (v.agent?.verified) return p.verified_agent;
  if (v.driver === "agent_then_human") return p.agent_then_human;
  if (v.driver === "agent" || v.driver === "human_then_agent" || v.driver === "mixed") return p.unverified_agent;
  if (v.probability >= 0.35 && v.probability < 0.7) return p.uncertain;
  return "allow";
}
