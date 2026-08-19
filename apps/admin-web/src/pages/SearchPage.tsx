import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type RequestRow } from "../api.js";

export function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RequestRow[] | null>(null);
  const navigate = useNavigate();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const r = await api.search(q);
    setResults(r.data);
  }

  return (
    <div>
      <h1>Search</h1>
      <form onSubmit={onSubmit} className="toolbar">
        <input
          type="search"
          style={{ flex: 1 }}
          placeholder="e.g. path:admin AND method:POST, or ip:203.0.113.4"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="primary" type="submit">
          Search
        </button>
      </form>
      <p className="muted">
        Fields: ip, actor, path, method, status_code, session, request_id. Combine with AND / OR / NOT (left-to-right, no parentheses yet).
      </p>
      {results && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th>Actor</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.requestId} onClick={() => navigate(`/actors/${r.actorId}`)}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.method}</td>
                  <td className="mono">{r.path}</td>
                  <td>{r.statusCode}</td>
                  <td className="mono">{r.actorId.slice(0, 8)}</td>
                  <td>{r.riskScore}</td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
