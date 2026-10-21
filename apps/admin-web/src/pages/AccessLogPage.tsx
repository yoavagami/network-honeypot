import { useEffect, useState } from "react";
import { api, type AccessLogResponse } from "../api.js";
import { StatCard } from "../components/StatCard.js";

const RANGES = ["24h", "7d", "30d", "all"];

const LOGIN_RESULT: Record<string, { label: string; badge: string }> = {
  success: { label: "success", badge: "low" },
  wrong_password: { label: "wrong password", badge: "high" },
  rate_limited: { label: "rate-limited", badge: "critical" },
  other: { label: "other", badge: "info" },
};

/** Superadmin only: who touched this dashboard itself. Routed behind RequireSuperadmin in
 * App.tsx; the API independently 404s anyone else, so this page can't leak data on its own. */
export function AccessLogPage() {
  const [range, setRange] = useState("7d");
  const [data, setData] = useState<AccessLogResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
    api.accessLog(range).then(setData).catch(() => setError(true));
  }, [range]);

  const you = (ip: string) => (data && ip === data.viewerIp ? <span className="badge info">you</span> : null);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Access Log</h1>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Everyone who reached this dashboard, including scanners that only saw the login page. Visible to superadmins only.
      </p>

      {error && <div className="banner error">Couldn't load the access log.</div>}
      {data && !data.available && <div className="banner warn">The access log isn't mounted on this server, so there's nothing to show.</div>}

      {data && data.available && (
        <>
          <div className="stat-grid">
            <StatCard label="Requests" value={data.totals.requests} />
            <StatCard label="Unique IPs" value={data.totals.uniqueIps} />
            <StatCard label="Successful logins" value={data.totals.loginsOk} />
            <StatCard label="Failed logins" value={data.totals.loginsFailed} />
          </div>

          <div className="panel">
            <h2>Visitors by IP</h2>
            <table>
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Requests</th>
                  <th>Logins OK</th>
                  <th>Logins failed</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {data.visitors.map((v) => (
                  <tr key={v.ip}>
                    <td className="mono">
                      {v.ip} {you(v.ip)}
                    </td>
                    <td>{v.hits}</td>
                    <td>{v.loginsOk > 0 ? <span className="badge low">{v.loginsOk}</span> : 0}</td>
                    <td>{v.loginsFailed > 0 ? <span className="badge high">{v.loginsFailed}</span> : 0}</td>
                    <td className="mono">{new Date(v.firstSeen).toLocaleString()}</td>
                    <td className="mono">{new Date(v.lastSeen).toLocaleString()}</td>
                    <td className="truncate" title={v.userAgent}>
                      {v.userAgent || <span className="muted">(none sent)</span>}
                    </td>
                  </tr>
                ))}
                {data.visitors.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      No one reached the dashboard in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Login attempts</h2>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>IP</th>
                  <th>Result</th>
                  <th>User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {data.logins.map((l, i) => (
                  <tr key={i}>
                    <td className="mono">{new Date(l.time).toLocaleString()}</td>
                    <td className="mono">
                      {l.ip} {you(l.ip)}
                    </td>
                    <td>
                      <span className={`badge ${LOGIN_RESULT[l.result]!.badge}`}>{LOGIN_RESULT[l.result]!.label}</span>
                    </td>
                    <td className="truncate" title={l.userAgent}>
                      {l.userAgent}
                    </td>
                  </tr>
                ))}
                {data.logins.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No login attempts in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Recent requests</h2>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>IP</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{new Date(r.time).toLocaleString()}</td>
                    <td className="mono">
                      {r.ip} {you(r.ip)}
                    </td>
                    <td>{r.method}</td>
                    <td className="mono truncate" title={r.uri}>
                      {r.uri}
                    </td>
                    <td>{r.status}</td>
                    <td className="truncate" title={r.userAgent}>
                      {r.userAgent}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.recent.length === 200 && <p className="muted" style={{ margin: ".75rem 1rem" }}>Showing the latest 200 requests.</p>}
          </div>
        </>
      )}
    </div>
  );
}
