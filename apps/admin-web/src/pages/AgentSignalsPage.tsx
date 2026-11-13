import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AgentSignalsResponse } from "../api.js";

const QUESTION_LABEL: Record<string, string> = {
  identity: "Who is it?",
  driver: "Is a human driving?",
  environment: "Is the environment real?",
  journey: "Shop journey",
};

/**
 * Every signal the agent score can use (packages/detection/src/signals.ts), its weight, and how
 * often it fired — overall, on signed lab runs and on human control runs. A signal that fires on
 * human control runs is a false-positive risk; one that never fires is dead weight.
 */
export function AgentSignalsPage() {
  const [range, setRange] = useState("7d");
  const [data, setData] = useState<AgentSignalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api.agentSignals(range).then(setData).catch((e) => setError(String(e.message ?? e)));
  }, [range]);
  const groups = ["identity", "driver", "environment", "journey"] as const;

  return (
    <div>
      <p><Link to="/agents">← Agents</Link></p>
      <h1>Score signals</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Each signal adds its weight (log-odds) toward "AI agent" (+) or "human / not an AI agent" (−). <em>AI-specific</em> signals lift the
        "not sure" cap; <em>no browser</em> signals mean no real browser ran. Weights are judgment until calibrated on signed lab runs.
      </p>
      <div className="toolbar">
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        {data && <span className="muted">{data.totalVisits} scored visits</span>}
      </div>
      {error && <div className="banner error">{error}</div>}
      {data && groups.map((g) => (
        <div className="panel" key={g}>
          <h2>{QUESTION_LABEL[g]}</h2>
          <table>
            <thead><tr><th>Signal</th><th>Weight</th><th>Meaning</th><th>Visits</th><th>Signed lab runs</th><th>Human control runs</th></tr></thead>
            <tbody>
              {data.data.filter((s) => s.question === g).sort((a, b) => b.visits - a.visits).map((s) => (
                <tr key={s.id}>
                  <td className="mono">
                    {s.id}
                    {s.aiSpecific && <span className="check-pill match" style={{ marginLeft: 6 }}>AI-specific</span>}
                    {s.scriptOnly && <span className="check-pill unknown" style={{ marginLeft: 6 }}>no browser</span>}
                  </td>
                  <td className="mono" title={s.dynamic}>{s.weight > 0 ? "+" : ""}{s.weight.toFixed(1)}{s.dynamic ? " *" : ""}</td>
                  <td className="cell-reason">{s.summary}{s.dynamic ? <span className="muted"> ({s.dynamic})</span> : null}</td>
                  <td>{s.visits || <span className="muted">0</span>}</td>
                  <td>{s.labVisits || <span className="muted">0</span>}</td>
                  <td className={s.humanLabVisits && s.weight > 0 ? "warn" : ""}>{s.humanLabVisits || <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
