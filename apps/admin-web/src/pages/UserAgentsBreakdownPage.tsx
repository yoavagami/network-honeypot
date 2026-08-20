import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, type UserAgentBreakdownRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

const RANGES = ["5m", "1h", "24h", "7d"];

export function UserAgentsBreakdownPage() {
  const [params, setParams] = useSearchParams();
  const range = params.get("range") ?? "24h";
  const [rows, setRows] = useState<UserAgentBreakdownRow[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.uniqueUserAgents(range).then((r) => setRows(r.data)).catch(console.error);
  }, [range]);

  return (
    <div>
      <div className="toolbar">
        <Link to="/" className="muted" style={{ marginRight: "auto" }}>
          ← Overview
        </Link>
        <select value={range} onChange={(e) => setParams({ range: e.target.value })}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <h1>Unique User-Agents</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Every distinct client string seen in the last {range}, ranked by volume. Click a row to see everything that client did.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>User-Agent</th>
              <th>Requests</th>
              <th>Actors</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Max risk</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.userAgent ?? "(none)"} onClick={() => navigate(`/requests?user_agent=${encodeURIComponent(r.userAgent ?? "")}`)} style={{ cursor: "pointer" }}>
                <td className="truncate" title={r.userAgent ?? undefined}>
                  {r.userAgent ?? <span className="muted">(none sent)</span>}
                </td>
                <td>{r.requestCount}</td>
                <td>{r.uniqueActors}</td>
                <td className="mono">{new Date(r.firstSeen).toLocaleString()}</td>
                <td className="mono">{new Date(r.lastSeen).toLocaleString()}</td>
                <td>
                  <SeverityBadge severity={riskToSeverity(r.maxRisk)} /> <span className="mono">{r.maxRisk}</span>
                </td>
              </tr>
            ))}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No requests in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
