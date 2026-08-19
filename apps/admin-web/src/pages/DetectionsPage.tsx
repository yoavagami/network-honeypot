import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DetectionRow } from "../api.js";

export function DetectionsPage() {
  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const navigate = useNavigate();

  function load() {
    api.detections({ limit: "100" }).then((r) => setDetections(r.data)).catch(console.error);
  }
  useEffect(load, []);

  async function ack(id: string) {
    await api.ackDetection(id);
    load();
  }

  return (
    <div>
      <h1>Detections</h1>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Actor</th>
              <th>Confidence</th>
              <th>Events</th>
              <th>Last seen</th>
              <th>Ack</th>
            </tr>
          </thead>
          <tbody>
            {detections.map((d) => (
              <tr key={d.detectionId}>
                <td>{d.detectionType}</td>
                <td className="mono" onClick={() => navigate(`/actors/${d.actorId}`)}>
                  {d.actorId.slice(0, 8)}
                </td>
                <td>{(Number(d.confidence) * 100).toFixed(0)}%</td>
                <td>{d.eventCount}</td>
                <td>{new Date(d.lastEventAt).toLocaleString()}</td>
                <td>
                  {d.acknowledged ? (
                    "✓"
                  ) : (
                    <button className="ghost" onClick={(e) => (e.stopPropagation(), ack(d.detectionId))}>
                      Ack
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {detections.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No detections yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
