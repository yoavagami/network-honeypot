import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type AgentBucket, type AgentConsistencyCheck, type AgentRequestRow, type AgentVisitsResponse } from "../api.js";
import { LabRunsPanel } from "../components/LabRunsPanel.js";
import { AgentBadge, ControlChip, ProbabilityBar, BUCKET_LABEL, CONTROL_LABEL, TYPE_LABEL } from "../components/AgentBadge.js";

const BUCKETS: AgentBucket[] = ["ai_agent", "probably_ai_agent", "not_sure", "not_ai_agent"];
const SHOP_STEP_LABEL: Record<string, string> = {
  SHOP_PRODUCT_VIEW: "viewed product",
  SHOP_ADD_TO_CART: "added to basket",
  SHOP_CHECKOUT_START: "started checkout",
  SHOP_CHECKOUT_DETAILS: "entered details",
  SHOP_CHECKOUT_SHIPPING: "chose shipping",
  SHOP_PAYMENT_ATTEMPT: "tried to pay",
  SHOP_ORDER_PLACED: "placed order",
};

type Tab = "visits" | "requests" | "lab";

/** "3 ✓" when the page agrees with the server, "1 ✗ language" when not, "—" without a page script. */
/** Lab label with whether it came from a signed link (ground truth) or a bare ?lab= (claimed). */
function LabCell({ lab, verified }: { lab: string | null; verified: boolean }) {
  if (!lab) return <span className="muted">—</span>;
  return (
    <span className="mono">
      {lab}{" "}
      <span className={`check-pill ${verified ? "match" : "unknown"}`} title={verified ? "Started from a signed lab link — ground truth" : "Bare ?lab= label — anyone can type one, so it isn't used as ground truth"}>
        {verified ? "signed" : "claimed"}
      </span>
    </span>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function ChecksCell({ checks }: { checks: AgentConsistencyCheck[] }) {
  if (!checks?.length) return <span className="muted">—</span>;
  const bad = checks.filter((c) => c.status === "mismatch");
  const ok = checks.filter((c) => c.status === "match").length;
  if (!bad.length) return <span className="check-pill match" title={checks.map((c) => `${c.label}: ${c.status}`).join("\n")}>{ok} ✓</span>;
  return <span className="check-pill mismatch" title={bad.map((c) => `${c.label}: ${c.page} vs ${c.server}`).join("\n")}>{bad.length} ✗ {bad.map((c) => c.id.replace(/_/g, " ")).join(", ")}</span>;
}

export function AgentsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("visits");
  const [range, setRange] = useState("7d");
  const [bucket, setBucket] = useState("");
  const [type, setType] = useState("");
  const [shop, setShop] = useState("");
  const [control, setControl] = useState("");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [why, setWhy] = useState("");
  const [whyInput, setWhyInput] = useState("");
  const [whyScope, setWhyScope] = useState("any");
  // Lab tab: every ?lab= label by default (signed and claimed, with a badge), or signed runs only.
  const [labScope, setLabScope] = useState<"verified" | "only">("only");
  const [visits, setVisits] = useState<AgentVisitsResponse | null>(null);
  // A run picked in the Lab runs table — shows exactly that label's visits.
  const [labPick, setLabPick] = useState<string>("");
  const [requests, setRequests] = useState<AgentRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (tab === "requests") {
      setRequests(null);
      const params: Record<string, string> = { range: range === "30d" ? "7d" : range };
      if (bucket) params.bucket = bucket;
      if (why) Object.assign(params, { why, whyScope });
      api.agentRequests(params).then((r) => setRequests(r.data)).catch((e) => setError(String(e.message ?? e)));
    } else {
      setVisits(null);
      const params: Record<string, string> = { range };
      if (tab === "lab") params.lab = q && labPick === q ? q : labScope;
      if (bucket) params.bucket = bucket;
      if (type) params.type = type;
      if (shop) params.shop = shop;
      if (control) params.control = control;
      if (q) params.q = q;
      if (why) Object.assign(params, { why, whyScope });
      api.agentVisits(params).then(setVisits).catch((e) => setError(String(e.message ?? e)));
    }
  }, [tab, range, bucket, type, shop, control, q, why, whyScope, labScope, labPick]);

  // Debounce typing: each change is a new query.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 400);
    return () => clearTimeout(t);
  }, [qInput]);
  useEffect(() => {
    const t = setTimeout(() => setWhy(whyInput.trim()), 400);
    return () => clearTimeout(t);
  }, [whyInput]);

  const typeOptions = useMemo(() => Object.keys(TYPE_LABEL), []);

  return (
    <div>
      <h1>Agents</h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        Probability that each visit was an AI agent, with the evidence. Scores are <strong>uncalibrated</strong> until tuned on labeled lab runs (<span className="mono">?lab=…</span>).
        Proof (a verified signature, an operator IP list, a known agent's page marker) overrides the score.{" "}
        <Link to="/agents/signals">All score signals →</Link>
      </p>

      <div className="tabs">
        <button className={tab === "visits" ? "active" : ""} onClick={() => setTab("visits")}>Visits</button>
        <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>Requests</button>
        <button className={tab === "lab" ? "active" : ""} onClick={() => setTab("lab")}>Lab runs</button>
      </div>

      {tab !== "requests" && visits && (
        <div className="stat-grid">
          {BUCKETS.map((b) => (
            <div key={b} className={`stat-card clickable`} role="button" tabIndex={0} onClick={() => setBucket(bucket === b ? "" : b)} style={bucket === b ? { borderColor: "var(--accent)" } : undefined}>
              <div className="label">{BUCKET_LABEL[b]}</div>
              <div className="value">{visits.counts[b] ?? 0}</div>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
          <option value="1h">Last hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <select value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Recommendation">
          <option value="">All recommendations</option>
          {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
        </select>
        {tab !== "requests" && (
          <>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
              <option value="">All types</option>
              {typeOptions.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <select value={shop} onChange={(e) => setShop(e.target.value)} aria-label="Shop activity">
              <option value="">Any activity</option>
              <option value="any">Used the shop</option>
              <option value="checkout">Reached checkout</option>
            </select>
            <select value={control} onChange={(e) => setControl(e.target.value)} aria-label="Driven by">
              <option value="">Driven by anyone</option>
              <option value="hybrid">Agent and human (any handover)</option>
              {["agent", "human", "agent_then_human", "human_then_agent", "mixed"].map((m) => <option key={m} value={m}>{CONTROL_LABEL[m]}</option>)}
            </select>
            <input type="search" placeholder="IP, user-agent, network, agent, label…" value={qInput} onChange={(e) => setQInput(e.target.value)} style={{ minWidth: 260 }} />
          </>
        )}
        <input
          type="search"
          placeholder="Why… e.g. tab*hidden, cursor_*, KPN"
          title="Filters on the reasons (text or signal name). * = anything, ? = one character. Not case-sensitive."
          value={whyInput}
          onChange={(e) => setWhyInput(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <select value={whyScope} onChange={(e) => setWhyScope(e.target.value)} aria-label="Why filter scope">
          <option value="any">in any reason</option>
          <option value="top">in top 2 reasons</option>
        </select>
      </div>

      {error && <div className="banner error">{error}</div>}
      {visits?.truncated && tab !== "requests" && <div className="banner warn">The "why" filter only searched the newest 5,000 visits in this range — narrow the time range or add filters.</div>}
      {visits && tab !== "requests" && (visits.lastScoredAt
        ? <p className="muted small">Scores are stored by the scoring worker as visits happen (open visits are rescored every ~30 s) · last update {ago(visits.lastScoredAt)}{visits.data[0]?.score.scorerVersion ? ` · scorer ${visits.data[0].score.scorerVersion}` : ""}</p>
        : <div className="banner warn">No stored scores yet. The honeypot's scoring worker fills this in as traffic arrives; to backfill history run <span className="mono">pnpm rescore --days 7</span>.</div>)}
      {tab === "lab" && (
        <>
          <LabRunsPanel onPick={(label) => { setLabPick(label); setQInput(label); setQ(label); }} />
          <div className="toolbar">
            <select value={labScope} onChange={(e) => { setLabScope(e.target.value as "verified" | "only"); setLabPick(""); }} aria-label="Lab labels">
              <option value="only">All lab labels (signed and claimed)</option>
              <option value="verified">Signed runs only (ground truth)</option>
            </select>
            {labPick && <button type="button" onClick={() => { setLabPick(""); setQInput(""); setQ(""); }}>Show all runs (now: {labPick})</button>}
          </div>
        </>
      )}

      {tab !== "requests" && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Last seen</th>
                {tab === "lab" && <th>Lab label</th>}
                <th>Recommendation</th>
                <th>P(AI agent)</th>
                <th>Type</th>
                <th title="Who drove the pages: an agent, a person, or a handover between them">Driven by</th>
                <th>Agent</th>
                <th>Why (top signals)</th>
                <th title="Server-vs-page consistency checks">Checks</th>
                <th>Requests</th>
                <th>Shop</th>
                <th>Network</th>
                <th>User-agent</th>
              </tr>
            </thead>
            <tbody>
              {!visits && <tr><td colSpan={13} className="muted">Scoring…</td></tr>}
              {visits?.data.map((v) => (
                <tr key={v.id} onClick={() => navigate(`/agents/${encodeURIComponent(v.id)}`)}>
                  <td>{new Date(v.lastAt).toLocaleString()}</td>
                  {tab === "lab" && <td><LabCell lab={v.lab} verified={v.labVerified} /></td>}
                  <td><AgentBadge bucket={v.score.bucket} />{v.score.proven && <span className="muted"> ✓ proven</span>}</td>
                  <td><ProbabilityBar p={v.score.probability} /></td>
                  <td>{TYPE_LABEL[v.score.type] ?? v.score.type}</td>
                  <td><ControlChip mode={v.score.control?.mode ?? "unknown"} handoverPath={v.score.control?.handover?.path} /></td>
                  <td className="mono">{v.score.agent ?? "—"}</td>
                  <td className="cell-reason">{v.score.reasons.slice(0, 2).map((r) => r.text).join(" · ") || "no distinguishing signals"}</td>
                  <td><ChecksCell checks={v.score.checks} /></td>
                  <td>{v.requestCount}{v.lab && tab !== "lab" ? <span className="muted"> · {v.lab}{v.labVerified ? " (signed)" : ""}</span> : null}{v.unboundBeacons ? <span className="check-pill mismatch" title="Page-script beacons for page loads this visitor was never served — left out of the score"> {v.unboundBeacons} forged</span> : null}</td>
                  <td>{v.shop ? `${SHOP_STEP_LABEL[v.shop.furthestStep ?? ""] ?? "browsed"}${v.shop.orderTotalCents ? ` · €${(v.shop.orderTotalCents / 100).toFixed(2)}` : ""}` : "—"}</td>
                  <td>{v.network ?? "—"}{v.country ? ` · ${v.country}` : ""}</td>
                  <td className="ua-cell" title={v.userAgent ?? ""}>{v.userAgent ?? "—"}</td>
                </tr>
              ))}
              {visits && visits.data.length === 0 && <tr><td colSpan={13} className="muted">{tab === "lab" ? "No lab visits in this range — create a signed link above and open the site with it." : "No visits in this range."}</td></tr>}
            </tbody>
          </table>
          {visits && visits.total > visits.data.length && <p className="muted">Showing {visits.data.length} of {visits.total} visits.</p>}
        </div>
      )}

      {tab === "requests" && (
        <div className="panel">
          <p className="muted" style={{ marginTop: 0 }}>Every page/API request with the score of the visit it belongs to (beacons and static assets hidden).</p>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Status</th>
                <th>Recommendation</th>
                <th>P(AI agent)</th>
                <th>Type</th>
                <th>Request identity</th>
                <th>Main reason</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {!requests && <tr><td colSpan={9} className="muted">Scoring…</td></tr>}
              {requests?.map((r) => (
                <tr key={r.requestId} onClick={() => navigate(`/agents/${encodeURIComponent(r.visitId)}`)}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td className="mono">{r.method} {r.path}</td>
                  <td>{r.status}</td>
                  <td><AgentBadge bucket={r.bucket} /></td>
                  <td><ProbabilityBar p={r.probability} /></td>
                  <td>{TYPE_LABEL[r.type] ?? r.type}</td>
                  <td className="mono">{r.requestVerdict}{r.requestAgent ? `:${r.requestAgent}` : ""}</td>
                  <td className="cell-reason">{r.topReason ?? "—"}</td>
                  <td className="mono">{r.ip ?? "—"}</td>
                </tr>
              ))}
              {requests && requests.length === 0 && <tr><td colSpan={9} className="muted">No requests in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
