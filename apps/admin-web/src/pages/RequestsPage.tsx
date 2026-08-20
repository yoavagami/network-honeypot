import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type RequestLogRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

interface Filters {
  path: string;
  method: string;
  ip: string;
  statusCode: string;
  userAgent: string;
  excludeUserAgent: string;
}

const EMPTY_FILTERS: Filters = { path: "", method: "", ip: "", statusCode: "", userAgent: "", excludeUserAgent: "" };

function toParams(filters: Filters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.path) params.path = filters.path;
  if (filters.method) params.method = filters.method;
  if (filters.ip) params.ip = filters.ip;
  if (filters.statusCode) params.status_code = filters.statusCode;
  if (filters.userAgent) params.user_agent = filters.userAgent;
  if (filters.excludeUserAgent) params.exclude_user_agent = filters.excludeUserAgent;
  return params;
}

export function RequestsPage() {
  const [rows, setRows] = useState<RequestLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const navigate = useNavigate();

  function load(activeFilters: Filters, before?: string | null) {
    setLoading(true);
    const params = { ...toParams(activeFilters), limit: "50", ...(before ? { cursor: before } : {}) };
    api
      .requests(params)
      .then((r) => {
        setRows((prev) => (before ? [...prev, ...r.data] : r.data));
        setCursor(r.nextCursor);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }
  useEffect(() => load(EMPTY_FILTERS), []); // eslint-disable-line react-hooks/exhaustive-deps

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setAppliedFilters(filters);
    load(filters);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    load(EMPTY_FILTERS);
  }

  const hasActiveFilters = Object.values(appliedFilters).some(Boolean);

  return (
    <div>
      <h1>Requests</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Every request the honeypot has recorded — timestamp, origin, and what it touched.
      </p>

      <form onSubmit={applyFilters} className="toolbar" style={{ flexWrap: "wrap", gap: ".5rem" }}>
        <input placeholder="Path contains…" value={filters.path} onChange={(e) => setFilters({ ...filters, path: e.target.value })} style={{ width: "12rem" }} />
        <input placeholder="Method (GET, POST…)" value={filters.method} onChange={(e) => setFilters({ ...filters, method: e.target.value.toUpperCase() })} style={{ width: "9rem" }} />
        <input placeholder="IP contains…" value={filters.ip} onChange={(e) => setFilters({ ...filters, ip: e.target.value })} style={{ width: "10rem" }} />
        <input placeholder="Status code" value={filters.statusCode} onChange={(e) => setFilters({ ...filters, statusCode: e.target.value })} style={{ width: "7rem" }} />
        <input placeholder="User-Agent contains…" value={filters.userAgent} onChange={(e) => setFilters({ ...filters, userAgent: e.target.value })} style={{ width: "12rem" }} />
        <input
          placeholder="User-Agent excludes… e.g. Render/1.0"
          value={filters.excludeUserAgent}
          onChange={(e) => setFilters({ ...filters, excludeUserAgent: e.target.value })}
          style={{ width: "14rem" }}
        />
        <button className="primary" type="submit">
          Filter
        </button>
        {hasActiveFilters && (
          <button type="button" className="ghost" onClick={clearFilters}>
            Clear
          </button>
        )}
      </form>

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
                  {hasActiveFilters ? "No requests match these filters." : "No requests recorded yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {cursor && (
          <button className="ghost" disabled={loading} onClick={() => load(appliedFilters, cursor)} style={{ margin: "1rem" }}>
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
