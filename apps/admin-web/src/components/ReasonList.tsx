import type { AgentReason } from "../api.js";

/** Each signal's push toward "AI agent" (+) or "human / not an AI agent" (−), biggest first. */
export function ReasonList({ reasons, directionOnly }: { reasons: AgentReason[]; directionOnly?: boolean }) {
  if (reasons.length === 0) return <p className="muted">No distinguishing signals — the score is the prior (an ordinary visit).</p>;
  return (
    <ul className="reason-list">
      {reasons.map((r, i) => (
        <li key={i}>
          {directionOnly
            ? <span className={`w ${r.weight > 0 ? "pos" : "neg"}`} title={r.weight > 0 ? "points to an agent" : r.weight < 0 ? "points to a person" : "context"}>{r.weight > 0 ? "agent ↑" : r.weight < 0 ? "human ↑" : "·"}</span>
            : <span className={`w ${r.weight > 0 ? "pos" : "neg"}`}>{r.weight > 0 ? "+" : ""}{r.weight.toFixed(1)}</span>}
          {!directionOnly && <span className="g">{r.group}</span>}
          <span>{r.text}</span>
        </li>
      ))}
    </ul>
  );
}
