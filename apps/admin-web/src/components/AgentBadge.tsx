import type { AgentBucket } from "../api.js";

export const BUCKET_LABEL: Record<AgentBucket, string> = {
  ai_agent: "AI agent",
  probably_ai_agent: "Probably AI agent",
  not_sure: "Not sure",
  not_ai_agent: "Not AI agent",
};

export const TYPE_LABEL: Record<string, string> = {
  cloud_browser_agent: "Cloud browser agent",
  in_browser_agent: "In-browser agent",
  user_triggered_fetcher: "User-triggered fetcher",
  ai_crawler: "AI crawler",
  search_crawler: "Search crawler",
  ai_app: "AI app",
  browser_automation: "Browser automation",
  script: "Script / HTTP client",
  scanner: "Scanner",
  human: "Human",
};

export function AgentBadge({ bucket }: { bucket: AgentBucket }) {
  return <span className={`badge agent-${bucket}`}>{BUCKET_LABEL[bucket]}</span>;
}

export function ProbabilityBar({ p }: { p: number }) {
  const pct = Math.round(p * 100);
  return (
    <span className="prob" title={`P(AI agent) = ${pct}%`}>
      <span className="prob-track">
        <span className="prob-fill" style={{ width: `${pct}%`, background: p >= 0.9 ? "var(--critical)" : p >= 0.7 ? "var(--high)" : p >= 0.35 ? "var(--medium)" : "var(--low)" }} />
      </span>
      <span className="prob-num">{pct}%</span>
    </span>
  );
}
