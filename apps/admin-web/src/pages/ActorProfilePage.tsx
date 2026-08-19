import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ActorProfile, type TimelineEntry } from "../api.js";
import { SeverityBadge } from "../components/SeverityBadge.js";
import { StatCard } from "../components/StatCard.js";

export function ActorProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<ActorProfile | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  useEffect(() => {
    if (!id) return;
    api.actor(id).then(setProfile).catch(console.error);
    api.actorTimeline(id).then((r) => setTimeline(r.data)).catch(console.error);
  }, [id]);

  if (!profile) return <p className="muted">Loading…</p>;

  return (
    <div>
      <h1>
        Actor <span className="mono">{profile.actorId}</span>
      </h1>

      <div className="stat-grid">
        <StatCard label="Risk score" value={profile.riskScore} />
        <StatCard label="Confidence" value={profile.confidence} />
        <StatCard label="Total requests" value={profile.totalRequests} />
        <StatCard label="Sessions" value={profile.sessionCount} />
        <StatCard label="IPs" value={profile.ipCount} />
        <StatCard label="User agents" value={profile.userAgentCount} />
        <StatCard label="Canary triggers" value={profile.canaryTriggerCount} />
        <StatCard label="Auth attempts" value={profile.authAttemptCount} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Identity signals</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Value</th>
                <th>Occurrences</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {profile.signals.map((s, i) => (
                <tr key={i}>
                  <td>{s.signalType}</td>
                  <td className="mono">{s.signalValue}</td>
                  <td>{s.occurrenceCount}</td>
                  <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: ".75rem" }}>
            Confidence reflects signal agreement, not certainty of identity — see docs/DETECTION.md §6.
          </p>
        </div>

        <div className="panel">
          <h2>Detections</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Confidence</th>
                <th>Events</th>
                <th>Ack</th>
              </tr>
            </thead>
            <tbody>
              {profile.detections.map((d) => (
                <tr key={d.detectionId}>
                  <td>{d.detectionType}</td>
                  <td>{(Number(d.confidence) * 100).toFixed(0)}%</td>
                  <td>{d.eventCount}</td>
                  <td>{d.acknowledged ? "yes" : "no"}</td>
                </tr>
              ))}
              {profile.detections.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No detections fired for this actor.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Attack timeline</h2>
        <ul className="timeline">
          {timeline.map((entry, i) => (
            <li key={i}>
              <span className="t-time">{new Date(entry.at).toLocaleTimeString()}</span>
              {entry.kind === "request" ? (
                <span>
                  {entry.method} {entry.path} → {entry.statusCode}
                </span>
              ) : (
                <span>
                  <SeverityBadge severity={entry.severity} /> {entry.eventType}
                </span>
              )}
            </li>
          ))}
          {timeline.length === 0 && <p className="muted">No activity recorded.</p>}
        </ul>
      </div>
    </div>
  );
}
