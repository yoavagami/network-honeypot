import type { AgentReason } from "../api.js";

/** Each signal's push toward "AI agent" (+) or "human / not an AI agent" (−), biggest first. */
export function ReasonList({ reasons }: { reasons: AgentReason[] }) {
  if (reasons.length === 0) return <p className="muted">No distinguishing signals — the score is the prior (an ordinary visit).</p>;
  return (
    <ul className="reason-list">
      {reasons.map((r, i) => (
        <li key={i}>
          <span className={`w ${r.weight > 0 ? "pos" : "neg"}`}>{r.weight > 0 ? "+" : ""}{r.weight.toFixed(1)}</span>
          <span className="g">{r.group}</span>
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
