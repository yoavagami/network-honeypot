import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type EventRow } from "../api.js";
import { SeverityBadge } from "../components/SeverityBadge.js";

export function AlertsPage() {
  const [alerts, setAlerts] = useState<EventRow[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.events({ event_type: "ALERT_TRIGGERED", limit: "100" }).then((r) => setAlerts(r.data)).catch(console.error);
  }, []);

  return (
    <div>
      <h1>Alerts</h1>
      <p className="muted">
        Threshold-crossing events (docs/ROADMAP.md Phase 2): high request rate, sustained auth failures, large-scale
        enumeration, sensitive-path access, and every canary trigger. Delivered to whatever's configured in{" "}
        <code>ALERT_WEBHOOK_URL</code> / <code>ALERT_SLACK_WEBHOOK_URL</code> / SMTP — recorded here regardless.
      </p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Severity</th>
              <th>Rule</th>
              <th>Description</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.eventId} onClick={() => navigate(`/actors/${a.actorId}`)}>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>
                  <SeverityBadge severity={a.severity} />
                </td>
                <td className="mono">{String(a.metadata.ruleId ?? "—")}</td>
                <td>{String(a.metadata.description ?? "—")}</td>
                <td className="mono">{a.actorId.slice(0, 8)}</td>
              </tr>
            ))}
            {alerts.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No alerts fired yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
