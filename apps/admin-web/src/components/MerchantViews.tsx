import { Link, useNavigate } from "react-router-dom";
import { AgentBadge, ControlChip, ProbabilityBar, TYPE_LABEL } from "./AgentBadge.js";
import { BarList } from "./BarList.js";
import { StatCard } from "./StatCard.js";
import type { Mode, OrderRow, Overview, VisitRow, IntegrationStatus } from "../merchantApi.js";

/**
 * Views shared by the admin's Merchant traffic page (all merchants, filterable) and the merchant
 * portal (one merchant). `showMerchant` adds the merchant column for admins; `base` is where row
 * links go ("/merchant-traffic" for admins, "/m" for merchants).
 */

export const fmtTime = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");
export const fmtMoney = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100); } catch { return `${(amount / 100).toFixed(2)} ${currency}`; }
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="tabs" style={{ marginBottom: 0, borderBottom: "none" }}>
      <button className={mode === "live" ? "active" : ""} onClick={() => onChange("live")}>Live data</button>
      <button className={mode === "test" ? "active" : ""} onClick={() => onChange("test")}>Test data</button>
    </div>
  );
}

export function ActionBadge({ action }: { action: string }) {
  const cls = action === "challenge" ? "critical" : action === "review" ? "medium" : "low";
  return <span className={`badge ${cls}`}>{action}</span>;
}

/** allow / confirm (ask the shopper first) / block. */
export function DecisionBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision) return <span className="muted">—</span>;
  const cls = decision === "block" ? "critical" : decision === "confirm" ? "medium" : "low";
  return <span className={`badge ${cls}`}>{decision}</span>;
}

/** P(AI agent) bar: the same coloured bar as the Agents list (green → yellow → orange → red). */
export function Score({ p }: { p: number }) {
  return <ProbabilityBar p={p} />;
}

export function AgentName({ agent, verified }: { agent: string | null; verified?: boolean }) {
  if (!agent) return <span className="muted">—</span>;
  return <span>{agent}{verified ? <span className="badge low" style={{ marginLeft: ".4rem" }}>verified</span> : null}</span>;
}

export function OverviewPanels({ data }: { data: Overview }) {
  const t = data.totals;
  const f = data.funnel;
  const group = (ds: string[]) => f.filter((r) => ds.includes(r.driver)).reduce((a, r) => ({ visits: a.visits + r.visits, checkout: a.checkout + r.reached_checkout, pay: a.pay + r.reached_pay, assessed: a.assessed + r.assessed }), { visits: 0, checkout: 0, pay: 0, assessed: 0 });
  const rows = [
    { label: "Agent only", ...group(["agent"]) },
    { label: "Agent → human", ...group(["agent_then_human"]) },
    { label: "Human → agent / mixed", ...group(["human_then_agent", "mixed"]) },
    { label: "Human", ...group(["human"]) },
    { label: "Unknown", ...group(["unknown"]) },
  ].filter((r) => r.visits > 0);
  return (
    <>
      <div className="stat-grid">
        <StatCard label={`Visits (${data.days} days)`} value={t.visits} />
        <StatCard label="Agent visits" value={`${t.agent_visits} (${pct(t.agent_share)})`} />
        <StatCard label="Verified agents" value={t.verified_agent_visits} />
        <StatCard label="Agent checkouts" value={`${t.agent_checkouts} of ${t.checkouts}`} />
        <StatCard label="Orders assessed" value={data.orders.assessed} />
        <StatCard label="Suggested review" value={data.orders.review + data.orders.challenge} />
      </div>
      <div className="grid-2">
        <div className="panel">
          <h2>Checkout funnel by who was driving</h2>
          {rows.length === 0 ? <p className="muted">No visits yet.</p> : (
            <table>
              <thead><tr><th>Driver</th><th>Visits</th><th>Reached checkout</th><th>Reached Pay</th><th>Assessed at Pay</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td><td>{r.visits}</td>
                    <td>{r.checkout} <span className="muted small">{r.visits ? pct(r.checkout / r.visits) : ""}</span></td>
                    <td>{r.pay} <span className="muted small">{r.checkout ? pct(r.pay / r.checkout) : ""}</span></td>
                    <td>{r.assessed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small" style={{ marginTop: ".75rem" }}>"Agent → human" means an agent browsed and a person took over — usually at payment.</p>
        </div>
        <div className="panel">
          <h2>Agents seen</h2>
          <BarList items={data.agents.map((a) => ({ label: `${a.agent}${a.verified ? " (verified)" : ""}`, count: a.visits }))} />
        </div>
      </div>
      {data.daily.length > 1 && (
        <div className="panel">
          <h2>Visits per day</h2>
          <BarList items={data.daily.map((d) => ({ label: `${d.day} — ${d.agent_visits} agent`, count: d.visits }))} />
        </div>
      )}
    </>
  );
}

/** Row props that open `to` on click or Enter, like the Agents list (the first cell stays a real link). */
function useRowLink() {
  const navigate = useNavigate();
  return (to: string) => ({
    className: "row-link",
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a, button, input, select")) return;
      if (e.metaKey || e.ctrlKey) window.open(to, "_blank");
      else navigate(to);
    },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") navigate(to); },
  });
}

export function VisitsTable({ visits, base, showMerchant, showLab, mode }: { visits: VisitRow[]; base: string; showMerchant?: boolean; showLab?: boolean; mode: Mode }) {
  const rowLink = useRowLink();
  if (!visits.length) return <p className="muted">No visits yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          {showMerchant && <th>Merchant</th>}<th>Last seen</th>{showLab && <th>Lab</th>}<th>Recommendation</th><th>P(AI agent)</th><th>Type</th><th>Agent</th>
          <th>Driven by</th><th title="Browser-vs-request consistency checks that failed / were compared">Checks</th><th>Pages</th><th>Checkout</th><th>Network</th>
        </tr>
      </thead>
      <tbody>
        {visits.map((v) => (
          <tr key={v.visit_id} {...rowLink(`${base}/visits/${v.visit_id}?mode=${mode}`)}>
            {showMerchant && <td><span title={v.merchant_id}>{v.company}</span></td>}
            <td><Link to={`${base}/visits/${v.visit_id}?mode=${mode}`}>{fmtTime(v.last_at)}</Link></td>
            {showLab && <td className="mono small">{v.lab_label ? `${v.lab_label}${v.lab_verified ? "" : " (claimed)"}` : ""}</td>}
            <td><AgentBadge bucket={v.bucket} /></td>
            <td><Score p={v.probability} /></td>
            <td>{TYPE_LABEL[v.type] ?? v.type}</td>
            <td><AgentName agent={v.agent} verified={v.proven} /></td>
            <td><ControlChip mode={v.driver} handoverPath={v.handover?.page} /></td>
            <td>{v.checks_compared ? <span className={`check-pill ${v.checks_failed ? "mismatch" : "match"}`}>{v.checks_failed ? `${v.checks_failed} of ${v.checks_compared} failed` : `${v.checks_compared} passed`}</span> : <span className="muted">—</span>}</td>
            <td>{v.page_count}</td>
            <td>{v.reached_pay ? "Pay" : v.reached_checkout ? "Checkout" : "—"}{v.assessments ? ` · ${v.assessments} assessed` : ""}</td>
            <td className="truncate" title={v.user_agent ?? ""}>{v.network?.organization ?? v.network?.country ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Recommendation filter options (same buckets as the Agents list). */
export const BUCKET_OPTIONS: Array<[string, string]> = [["", "Any recommendation"], ["ai_agent", "AI agent"], ["probably_ai_agent", "Probably AI agent"], ["not_sure", "Not sure"], ["not_ai_agent", "Not an AI agent"]];

/** Header line above a merchant visit (both dashboards). */
export function MerchantVisitHeader({ v, showLab }: { v: import("../api.js").AgentVisitDetail; showLab?: boolean }) {
  return (
    <p className="muted" style={{ marginTop: "-.5rem" }}>
      {new Date(v.firstAt).toLocaleString()} → {new Date(v.lastAt).toLocaleTimeString()} · {v.pageCount} page view{v.pageCount === 1 ? "" : "s"}
      {" · "}{v.network.organization ?? "unknown network"}{v.network.country ? ` · ${v.network.country}` : ""}
      {v.merchant && !v.merchant.settled ? " · still open (the verdict can still change)" : ""}
      {showLab && v.lab ? <> · lab label <strong className="mono">{v.lab}</strong> <span className={`check-pill ${v.labVerified ? "match" : "unknown"}`}>{v.labVerified ? "signed" : "claimed"}</span></> : null}
    </p>
  );
}

export function OrdersTable({ orders, base, showMerchant, mode }: { orders: OrderRow[]; base: string; showMerchant?: boolean; mode: Mode }) {
  const rowLink = useRowLink();
  if (!orders.length) return <p className="muted">No assessed orders yet.</p>;
  return (
    <table>
      <thead>
        <tr>{showMerchant && <th>Merchant</th>}<th>When</th><th>Order</th><th>Amount</th><th>Driven by</th><th>Agent</th><th>Score</th><th>Decision</th><th>Suggested</th><th>Final</th><th>Outcome</th></tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.assessment_id} {...rowLink(`${base}/orders/${o.assessment_id}?mode=${mode}`)}>
            {showMerchant && <td><span title={o.merchant_id}>{o.company}</span></td>}
            <td><Link to={`${base}/orders/${o.assessment_id}?mode=${mode}`}>{fmtTime(o.created_at)}</Link></td>
            <td>{o.order_id}</td>
            <td>{fmtMoney(o.amount, o.currency)}</td>
            <td><ControlChip mode={o.driver} /></td>
            <td><AgentName agent={o.agent?.id ?? null} verified={o.agent?.verified} /></td>
            <td><Score p={o.score} /></td>
            <td><DecisionBadge decision={o.decision} /></td>
            <td><ActionBadge action={o.suggested_action} /></td>
            <td>{o.final ? "yes" : <span className="muted">not yet</span>}</td>
            <td>{o.outcome ?? <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChecklistView({ status }: { status: IntegrationStatus }) {
  const icon = (s: string) => (s === "pass" ? "✓" : s === "not_applicable" ? "–" : s === "pending" ? "…" : "✗");
  const cls = (s: string) => (s === "pass" ? "low" : s === "fail" ? "critical" : "info");
  return (
    <>
      <div className={`banner ${status.all_passed ? "" : "warn"}`} style={{ marginBottom: "1rem" }}>
        {status.all_passed ? "Integration complete for this mode." : "Some checks are not passing yet. Each one says what to do next."}
      </div>
      <table>
        <thead><tr><th></th><th>Check</th><th>Detail</th></tr></thead>
        <tbody>
          {status.checks.map((c) => (
            <tr key={c.id}><td><span className={`badge ${cls(c.status)}`}>{icon(c.status)}</span></td><td><code>{c.id}</code></td><td>{c.detail}</td></tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: "1rem" }}>Last events received</h3>
      {status.recent_events.length === 0 ? <p className="muted">Nothing received yet.</p> : (
        <ul>{status.recent_events.map((e, i) => <li key={i}>{fmtTime(e.at)} — {e.type} {e.origin ? <span className="muted">from {e.origin}</span> : null}</li>)}</ul>
      )}
    </>
  );
}
