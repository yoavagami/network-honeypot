import { useNavigate } from "react-router-dom";
import { useLiveEvents } from "../hooks/useSSE.js";
import { SeverityBadge } from "../components/SeverityBadge.js";

export function LiveStreamPage() {
  const { events, connected } = useLiveEvents();
  const navigate = useNavigate();

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Live Event Stream</h1>
        <span className={`badge ${connected ? "low" : "critical"}`}>{connected ? "connected" : "disconnected"}</span>
      </div>
      <div className="panel stream-list">
        {events.length === 0 && <p className="muted">Waiting for events…</p>}
        {events.map((e) => (
          <div className="stream-item" key={e.eventId} onClick={() => navigate(`/events/${e.eventId}`)}>
            <span className="time">{new Date(e.createdAt).toLocaleTimeString()}</span>
            <span>{e.eventType}</span>
            <span className="muted">{e.actorId.slice(0, 8)}</span>
            <SeverityBadge severity={e.severity} />
          </div>
        ))}
      </div>
    </div>
  );
}
