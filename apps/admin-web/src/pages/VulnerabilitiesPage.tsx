import { useEffect, useState } from "react";
import { api, type VulnerabilityRow } from "../api.js";

const RANGES = ["1h", "24h", "7d"];

export function VulnerabilitiesPage() {
  const [range, setRange] = useState("24h");
  const [rows, setRows] = useState<VulnerabilityRow[]>([]);

  useEffect(() => {
    api.vulnerabilities(range).then((r) => setRows(r.data)).catch(console.error);
  }, [range]);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Vulnerabilities</h1>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Intentionally vulnerable components — real exploitation mechanics against synthetic data. See docs/VULNERABILITY.md.
      </p>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Vulnerability</th>
              <th>Category</th>
              <th>Endpoint</th>
              <th>First attempt</th>
              <th>First confirmed</th>
              <th>Actors</th>
              <th>Attempts</th>
              <th>Confirmed</th>
              <th>Data access / iteration events</th>
              <th>Canary events</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vulnerability}>
                <td>{r.vulnerability}</td>
                <td>{r.category}</td>
                <td className="mono">{r.endpoint}</td>
                <td>{r.firstAttemptAt ? new Date(r.firstAttemptAt).toLocaleString() : <span className="muted">—</span>}</td>
                <td>{r.firstConfirmedAt ? new Date(r.firstConfirmedAt).toLocaleString() : <span className="muted">—</span>}</td>
                <td>{r.actors}</td>
                <td>{r.attempts}</td>
                <td>
                  <span className={r.confirmed > 0 ? "badge critical" : "badge info"}>{r.confirmed}</span>
                </td>
                <td>{r.dataExtractionEvents}</td>
                <td>
                  <span className={r.canaryEvents > 0 ? "badge critical" : "badge info"}>{r.canaryEvents}</span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  No vulnerable-endpoint activity in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
