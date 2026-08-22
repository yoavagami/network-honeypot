import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type ActorRow, type EventRow, type RequestRow } from "../api.js";
import { SeverityBadge } from "../components/SeverityBadge.js";

export function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ event: EventRow; request: RequestRow | null; actor: ActorRow | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    api.event(id).then(setData).catch(console.error);
  }, [id]);

  if (!data) return <p className="muted">Loading…</p>;
  const { event, request, actor } = data;

  return (
    <div>
      <h1>
        Event <SeverityBadge severity={event.severity} />
      </h1>

      <div className="grid-2">
        <div className="panel">
          <h2>Event</h2>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{event.eventType}</dd>
            <dt>Time</dt>
            <dd>{new Date(event.createdAt).toLocaleString()}</dd>
            <dt>Risk score</dt>
            <dd>{event.riskScore}</dd>
            <dt>Source</dt>
            <dd>{event.source}</dd>
            <dt>Actor</dt>
            <dd>{actor ? <Link to={`/actors/${actor.actorId}`}>{actor.actorId}</Link> : event.actorId}</dd>
            <dt>Metadata</dt>
            <dd>
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(event.metadata, null, 2)}</pre>
            </dd>
          </dl>
        </div>

        {request && (
          <div className="panel">
            <h2>Request</h2>
            <dl className="kv">
              <dt>Method / Path</dt>
              <dd>
                {request.method} {request.path}
              </dd>
              <dt>Status</dt>
              <dd>{request.statusCode}</dd>
              <dt>Query</dt>
              <dd>{request.queryString ?? "—"}</dd>
              <dt>Duration</dt>
              <dd>{request.durationMs} ms</dd>
              <dt>User-Agent</dt>
              <dd>{request.userAgentRaw ?? "—"}</dd>
              <dt>Endpoint</dt>
              <dd>{request.endpoint}</dd>
              <dt>Component</dt>
              <dd>{request.applicationComponent}</dd>
              <dt>IP hash</dt>
              <dd>{request.ipHash}</dd>
              <dt>Host</dt>
              <dd>{request.host}</dd>
              <dt>TLS</dt>
              <dd>{request.tlsVersion ? `${request.tlsVersion} · ${request.tlsCipher} · ALPN ${request.alpn ?? "—"}` : "— (plain HTTP)"}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
