import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, type IpBreakdownRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

const RANGES = ["5m", "1h", "24h", "7d"];

export function IpsBreakdownPage() {
  const [params, setParams] = useSearchParams();
  const range = params.get("range") ?? "24h";
  const [rows, setRows] = useState<IpBreakdownRow[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.uniqueIps(range).then((r) => setRows(r.data)).catch(console.error);
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
      <h1>Unique IPs</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Every distinct source seen in the last {range}, ranked by volume. Click a row to see everything that IP touched.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>IP</th>
              <th>Requests</th>
              <th>Actors</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Max risk</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.ipHash} onClick={() => navigate(`/requests?ip_hash=${r.ipHash}`)} style={{ cursor: "pointer" }}>
                <td className="mono" title={r.ipHash}>
                  {r.latestIpRaw ?? <span className="muted">redacted (hash only)</span>}
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
