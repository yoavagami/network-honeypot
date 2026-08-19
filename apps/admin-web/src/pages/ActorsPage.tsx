import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ActorRow } from "../api.js";
import { SeverityBadge, riskToSeverity } from "../components/SeverityBadge.js";

export function ActorsPage() {
  const [actors, setActors] = useState<ActorRow[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.actors({ limit: "100" }).then((r) => setActors(r.data)).catch(console.error);
  }, []);

  return (
    <div>
      <h1>Actors</h1>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Actor</th>
              <th>Confidence</th>
              <th>Risk</th>
              <th>Requests</th>
              <th>Unique paths</th>
              <th>First seen</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {actors.map((a) => (
              <tr key={a.actorId} onClick={() => navigate(`/actors/${a.actorId}`)}>
                <td className="mono">{a.actorId.slice(0, 8)}</td>
                <td>{a.confidence}</td>
                <td>
                  <SeverityBadge severity={riskToSeverity(a.riskScore)} /> {a.riskScore}
                </td>
                <td>{a.totalRequests}</td>
                <td>{a.uniquePaths}</td>
                <td>{new Date(a.firstSeenAt).toLocaleString()}</td>
                <td>{new Date(a.lastSeenAt).toLocaleString()}</td>
              </tr>
            ))}
            {actors.length === 0 && (
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
