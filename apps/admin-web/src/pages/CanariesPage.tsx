import { useEffect, useState } from "react";
import { api, type CanaryRow } from "../api.js";

export function CanariesPage() {
  const [canaries, setCanaries] = useState<CanaryRow[]>([]);

  useEffect(() => {
    api.canaries().then((r) => setCanaries(r.data)).catch(console.error);
  }, []);

  return (
    <div>
      <h1>Canaries</h1>
      <p className="muted">Synthetic secrets planted throughout the honeypot. Any use of one is a near-certain sign of exploitation intent.</p>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Value</th>
              <th>Planted at</th>
              <th>Triggers</th>
            </tr>
          </thead>
          <tbody>
            {canaries.map((c) => (
              <tr key={c.canaryId}>
                <td>{c.canaryType}</td>
                <td className="mono">{c.value}</td>
                <td>{c.plantedLocation}</td>
                <td>
                  <span className={c.triggerCount > 0 ? "badge critical" : "badge info"}>{c.triggerCount}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
