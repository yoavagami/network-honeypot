import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type RequestLogRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

interface Filters {
  path: string;
  method: string;
  ip: string;
  statusCode: string;
  userAgent: string;
  excludeUserAgent: string;
  /** Not a visible text field — arrives pre-set from the Overview page's "Unique IPs"
   * drill-down, where ip_hash (not raw IP, which may already be redacted) is the exact key. */
  ipHash: string;
  /** Same idea, from the "Errors (4xx/5xx)" drill-down. */
  minStatus: string;
}

const EMPTY_FILTERS: Filters = { path: "", method: "", ip: "", statusCode: "", userAgent: "", excludeUserAgent: "", ipHash: "", minStatus: "" };

function filtersFromSearchParams(params: URLSearchParams): Filters {
  return {
    path: params.get("path") ?? "",
    method: params.get("method") ?? "",
    ip: params.get("ip") ?? "",
    statusCode: params.get("status_code") ?? "",
    userAgent: params.get("user_agent") ?? "",
    excludeUserAgent: params.get("exclude_user_agent") ?? "",
    ipHash: params.get("ip_hash") ?? "",
    minStatus: params.get("min_status") ?? "",
  };
}

function toParams(filters: Filters): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.path) params.path = filters.path;
  if (filters.method) params.method = filters.method;
  if (filters.ip) params.ip = filters.ip;
  if (filters.statusCode) params.status_code = filters.statusCode;
  if (filters.userAgent) params.user_agent = filters.userAgent;
  if (filters.excludeUserAgent) params.exclude_user_agent = filters.excludeUserAgent;
  if (filters.ipHash) params.ip_hash = filters.ipHash;
  if (filters.minStatus) params.min_status = filters.minStatus;
  return params;
}

export function RequestsPage() {
  const [searchParams] = useSearchParams();
  const initialFilters = filtersFromSearchParams(searchParams);
  const [rows, setRows] = useState<RequestLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(initialFilters);
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
  useEffect(() => load(initialFilters), []); // eslint-disable-line react-hooks/exhaustive-deps

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

      {(appliedFilters.ipHash || appliedFilters.minStatus) && (
        <div className="toolbar" style={{ gap: ".5rem" }}>
          {appliedFilters.ipHash && <span className="badge info">IP hash: {appliedFilters.ipHash.slice(0, 12)}…</span>}
          {appliedFilters.minStatus && <span className="badge info">Status ≥ {appliedFilters.minStatus}</span>}
        </div>
      )}

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
              <th>Accessed via</th>
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
                <td>
                  {r.isDirectIp ? (
                    <span className="badge info" title={`Host header: ${r.host}`}>
                      IP
                    </span>
                  ) : (
                    <span className="mono truncate" title={r.host}>
                      {r.host}
                    </span>
                  )}
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
                <td colSpan={9} className="muted">
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
