import { useEffect, useState } from "react";
import { api, type AgentBucket, type LabRunCreated, type LabRunsResponse } from "../api.js";
import { BUCKET_LABEL } from "./AgentBadge.js";

const BUCKETS: AgentBucket[] = ["ai_agent", "probably_ai_agent", "not_sure", "not_ai_agent"];

/**
 * Lab runs: mint a signed link for a controlled visit (an agent we run, or a human control run)
 * and see how each run was scored. Only signed runs count as ground truth — a bare ?lab= label
 * is "claimed", because any visitor can type one (admin-api routes/lab.ts).
 */
export function LabRunsPanel({ onPick }: { onPick: (label: string) => void }) {
  const [runs, setRuns] = useState<LabRunsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"agent" | "human">("agent");
  const [label, setLabel] = useState("");
  const [agent, setAgent] = useState("");
  const [scenario, setScenario] = useState("");
  const [ttl, setTtl] = useState("2");
  const [created, setCreated] = useState<LabRunCreated | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.labRuns().then(setRuns).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { void load(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await api.createLabRun({ label, kind, agent: agent || undefined, scenario: scenario || undefined, ttlDays: Number(ttl) });
      setCreated(res);
      setLabel("");
      void load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setBusy(false);
    }
  };
  const link = created ? created.url ?? created.query : null;

  return (
    <div className="panel">
      <h2>Lab runs</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Start every controlled visit from a <strong>signed link</strong>: the browser that opens it is tagged with the label until the link expires,
        and only signed runs count as ground truth. Name runs <span className="mono">&lt;agent&gt;-&lt;scenario&gt;-&lt;n&gt;</span> (e.g.{" "}
        <span className="mono">claude-chrome-checkout-1</span>), and human control runs <span className="mono">human-&lt;browser&gt;-&lt;n&gt;</span>.
        Add <span className="mono">-proxied</span> when the run goes through your own proxy, so its network fingerprint isn't mistaken for the browser's.
        This table lists signed links; every visit with a lab label, signed or typed, is in the list below.
      </p>
      {runs && !runs.enabled && <div className="banner warn">LAB_LINK_SECRET isn't set on admin-api, so links can't be signed. Labels typed as ?lab=… are recorded as "claimed" only.</div>}
      <form className="toolbar" onSubmit={submit}>
        <select value={kind} onChange={(e) => setKind(e.target.value as "agent" | "human")} aria-label="Run kind">
          <option value="agent">Agent run</option>
          <option value="human">Human control run</option>
        </select>
        <input required placeholder={kind === "human" ? "human-safari-1" : "browser-use-checkout-1"} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" style={{ minWidth: 220 }} />
        <input placeholder={kind === "human" ? "browser (optional)" : "agent (optional)"} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent" />
        <input placeholder="scenario (optional)" value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Scenario" />
        <select value={ttl} onChange={(e) => setTtl(e.target.value)} aria-label="Link lifetime">
          <option value="0.25">valid 6 hours</option>
          <option value="1">valid 1 day</option>
          <option value="2">valid 2 days</option>
          <option value="7">valid 7 days</option>
        </select>
        <button type="submit" disabled={busy || !runs?.enabled}>Create signed link</button>
      </form>
      {error && <div className="banner error">{error}</div>}
      {link && (
        <div className="banner">
          Link for <strong className="mono">{created!.label}</strong> (expires {new Date(created!.expiresAt).toLocaleString()}):{" "}
          <span className="mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{link}</span>{" "}
          <button type="button" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button>
          {!created!.url && <span className="muted small"> — append to the site's URL (set PUBLIC_SITE_URL on admin-api for a full link)</span>}
        </div>
      )}
      <table>
        <thead>
          <tr><th>Label</th><th>Kind</th><th>Agent / scenario</th><th>Created</th><th>Expires</th><th>Visits</th><th>Verdicts</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {runs?.data.map((r) => (
            <tr key={r.label} onClick={() => onPick(r.label)} title="Show this run's visits">
              <td className="mono">{r.label}</td>
              <td>{r.kind === "human" ? "human control" : "agent"}</td>
              <td>{[r.agent, r.scenario].filter(Boolean).join(" · ") || "—"}</td>
              <td>{new Date(r.createdAt).toLocaleString()}{r.createdBy ? <span className="muted"> · {r.createdBy}</span> : null}</td>
              <td className={new Date(r.expiresAt) < new Date() ? "muted" : ""}>{new Date(r.expiresAt).toLocaleString()}</td>
              <td>{r.visits}{r.proven ? <span className="muted"> · {r.proven} proven</span> : null}</td>
              <td>{BUCKETS.filter((b) => r.buckets[b]).map((b) => `${r.buckets[b]} ${BUCKET_LABEL[b].toLowerCase()}`).join(", ") || "—"}</td>
              <td>{r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {runs && runs.data.length === 0 && (
            <tr><td colSpan={8} className="muted">
              No signed runs yet. Visits opened with a typed <span className="mono">?lab=…</span> label still appear in the list below, marked
              <span className="check-pill unknown" style={{ margin: "0 4px" }}>claimed</span>— they aren't ground truth because anyone can type one.
              Create a signed link here and open it (through any proxy: only the query string matters) to record a signed run.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
