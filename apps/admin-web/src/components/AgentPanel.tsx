import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AgentRequestScore } from "../api.js";
import { AgentBadge, ProbabilityBar, TYPE_LABEL } from "./AgentBadge.js";
import { ReasonList } from "./ReasonList.js";

/** Agent analysis for one request (its visit's score) — shown on request/event detail pages. */
export function AgentPanel({ requestId }: { requestId: string }) {
  const [s, setS] = useState<AgentRequestScore | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => {
    api.agentByRequest(requestId).then(setS).catch((e) => setMissing(String(e.message ?? e)));
  }, [requestId]);
  return (
    <div className="panel">
      <h2>Agent analysis</h2>
      {missing && <p className="muted">{missing}</p>}
      {!s && !missing && <p className="muted">Scoring…</p>}
      {s && (
        <>
          <div className="verdict-hero" style={{ marginBottom: ".75rem" }}>
            <AgentBadge bucket={s.bucket} />
            <ProbabilityBar p={s.probability} />
            <span>{TYPE_LABEL[s.type] ?? s.type}{s.agent ? <span className="mono"> · {s.agent}</span> : null}</span>
            <Link to={`/agents/${encodeURIComponent(s.visitId)}`}>Full visit →</Link>
          </div>
          <ReasonList reasons={s.reasons.slice(0, 6)} />
        </>
      )}
    </div>
  );
}
