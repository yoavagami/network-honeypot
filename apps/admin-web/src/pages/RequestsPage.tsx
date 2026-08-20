import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type RequestLogRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

export function RequestsPage() {
  const [rows, setRows] = useState<RequestLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  function load(before?: string | null) {
    setLoading(true);
    api
      .requests(before ? { cursor: before, limit: "50" } : { limit: "50" })
      .then((r) => {
        setRows((prev) => (before ? [...prev, ...r.data] : r.data));
        setCursor(r.nextCursor);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }
  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h1>Requests</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Every request the honeypot has recorded — timestamp, origin, and what it touched.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>IP</th>
              <th>Country</th>
              <th>User-Agent</th>
              <th>Method</th>
              <th>Path</th>
              <th>Status</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.requestId} onClick={() => navigate(`/actors/${r.actorId}`)} style={{ cursor: "pointer" }}>
                <td className="mono">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="mono" title={r.ipHash}>
                  {r.ipRaw ?? <span className="muted">redacted</span>}
                </td>
                <td>{[r.city, r.country].filter(Boolean).join(", ") || <span className="muted">—</span>}</td>
                <td className="truncate" title={r.userAgentRaw ?? undefined}>
                  {r.userAgentRaw ?? <span className="muted">—</span>}
                </td>
                <td>{r.method}</td>
                <td className="mono truncate" title={r.path + (r.queryString ? `?${r.queryString}` : "")}>
                  {r.path}
                </td>
                <td>{r.statusCode}</td>
                <td>
                  <SeverityBadge severity={riskToSeverity(r.riskScore)} /> <span className="mono">{r.riskScore}</span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="muted">
                  No requests recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {cursor && (
          <button className="ghost" disabled={loading} onClick={() => load(cursor)} style={{ margin: "1rem" }}>
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
