import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type FirstContactRow } from "../api.js";

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function FirstContactPage() {
  const [rows, setRows] = useState<FirstContactRow[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.firstContact().then((r) => setRows(r.data)).catch(console.error);
  }, []);

  return (
    <div>
      <h1>First Contact</h1>
      <p className="muted">
        For each actor: how long after their first request did they reach suspicious activity, an
        auth attempt, enumeration, API probing, or a canary trigger. Answers "how fast did discovery
        turn into exploitation-like behavior?" — see docs/ROADMAP.md Phase 2.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Actor</th>
              <th>First seen</th>
              <th>To suspicious</th>
              <th>To auth attempt</th>
              <th>To enumeration</th>
              <th>To API probe</th>
              <th>To canary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const toSeconds = (from: string, to: string | null) => (to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000) : null);
              return (
                <tr key={r.actorId} onClick={() => navigate(`/actors/${r.actorId}`)}>
                  <td className="mono">{r.actorId.slice(0, 8)}</td>
                  <td>{new Date(r.firstSeenAt).toLocaleString()}</td>
                  <td>{formatDuration(r.secondsToFirstSuspicious)}</td>
                  <td>{formatDuration(toSeconds(r.firstSeenAt, r.firstAuthAttemptAt))}</td>
                  <td>{formatDuration(toSeconds(r.firstSeenAt, r.firstEnumerationAt))}</td>
                  <td>{formatDuration(toSeconds(r.firstSeenAt, r.firstApiProbeAt))}</td>
                  <td>{r.secondsToFirstCanary !== null ? <span className="badge critical">{formatDuration(r.secondsToFirstCanary)}</span> : "—"}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No actors observed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
