import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type AgentVisitDetail } from "../api.js";
import { VisitDetailBody } from "../components/VisitDetail.js";

export function AgentVisitPage() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<AgentVisitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.agentVisit(id).then(setV).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  if (error) return <div className="banner error">{error}</div>;
  if (!v) return <p className="muted">Scoring…</p>;

  return (
    <div>
      <p><Link to="/agents">← Agents</Link></p>
      <h1>Visit <span className="mono">{v.id.slice(0, 40)}</span></h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        {new Date(v.firstAt).toLocaleString()} → {new Date(v.lastAt).toLocaleTimeString()} · {v.requestCount} requests · {v.network.organization ?? "unknown network"}
        {v.network.country ? ` · ${v.network.city ? `${v.network.city}, ` : ""}${v.network.country}` : ""} · <Link to={`/actors/${v.actorId}`}>actor {v.actorId.slice(0, 8)}</Link>
        {v.lab ? <> · lab label <strong className="mono">{v.lab}</strong> <span className={`check-pill ${v.labVerified ? "match" : "unknown"}`} title={v.labVerified ? "Started from a signed lab link — ground truth" : "Bare ?lab= label — anyone can type one, so it isn't ground truth"}>{v.labVerified ? "signed" : "claimed"}</span></> : null}
      </p>

      <VisitDetailBody v={v} variant="honeypot" />
    </div>
  );
}
