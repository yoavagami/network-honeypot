import { Link } from "react-router-dom";
import { ControlChip } from "./AgentBadge.js";
import { BarList } from "./BarList.js";
import { StatCard } from "./StatCard.js";
import type { Mode, OrderRow, Overview, VisitDetail, VisitRow, IntegrationStatus } from "../merchantApi.js";

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

export function Score({ p }: { p: number }) {
  return (
    <span className="prob" title="Probability that an AI agent was involved (not yet calibrated)">
      <span className="prob-track"><span className="prob-fill" style={{ width: `${Math.round(p * 100)}%` }} /></span>
      <span className="prob-num">{Math.round(p * 100)}%</span>
    </span>
  );
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

export function VisitsTable({ visits, base, showMerchant, mode }: { visits: VisitRow[]; base: string; showMerchant?: boolean; mode: Mode }) {
  if (!visits.length) return <p className="muted">No visits yet.</p>;
  return (
    <table>
      <thead>
        <tr>{showMerchant && <th>Merchant</th>}<th>Last seen</th><th>Driven by</th><th>Agent</th><th>Score</th><th>Pages</th><th>Checkout</th><th>Network</th></tr>
      </thead>
      <tbody>
        {visits.map((v) => (
          <tr key={v.visit_id}>
            {showMerchant && <td><span title={v.merchant_id}>{v.company}</span></td>}
            <td><Link to={`${base}/visits/${v.visit_id}?mode=${mode}`}>{fmtTime(v.last_at)}</Link></td>
            <td><ControlChip mode={v.driver} handoverPath={v.handover?.page} /></td>
            <td><AgentName agent={v.agent} verified={v.proven} /></td>
            <td><Score p={v.probability} /></td>
            <td>{v.page_count}</td>
            <td>{v.reached_pay ? "Pay" : v.reached_checkout ? "Checkout" : "—"}{v.assessments ? ` · ${v.assessments} assessed` : ""}</td>
            <td className="truncate" title={v.user_agent ?? ""}>{v.network?.organization ?? v.network?.country ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OrdersTable({ orders, base, showMerchant, mode }: { orders: OrderRow[]; base: string; showMerchant?: boolean; mode: Mode }) {
  if (!orders.length) return <p className="muted">No assessed orders yet.</p>;
  return (
    <table>
      <thead>
        <tr>{showMerchant && <th>Merchant</th>}<th>When</th><th>Order</th><th>Amount</th><th>Driven by</th><th>Agent</th><th>Score</th><th>Suggested</th><th>Final</th><th>Outcome</th></tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.assessment_id}>
            {showMerchant && <td><span title={o.merchant_id}>{o.company}</span></td>}
            <td><Link to={`${base}/orders/${o.assessment_id}?mode=${mode}`}>{fmtTime(o.created_at)}</Link></td>
            <td>{o.order_id}</td>
            <td>{fmtMoney(o.amount, o.currency)}</td>
            <td><ControlChip mode={o.driver} /></td>
            <td><AgentName agent={o.agent?.id ?? null} verified={o.agent?.verified} /></td>
            <td><Score p={o.score} /></td>
            <td><ActionBadge action={o.suggested_action} /></td>
            <td>{o.final ? "yes" : <span className="muted">not yet</span>}</td>
            <td>{o.outcome ?? <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function VisitDetailView({ d, base, mode }: { d: VisitDetail; base: string; mode: Mode }) {
  const v = d.visit;
  return (
    <>
      <div className="panel verdict-hero">
        <div className="kv">
          <div><span className="muted">Driven by</span> <ControlChip mode={v.driver} handoverPath={v.handover?.page} /></div>
          <div><span className="muted">Agent</span> <AgentName agent={v.agent} verified={v.proven} /></div>
          <div><span className="muted">Score</span> <Score p={v.probability} /></div>
          <div><span className="muted">Type</span> {v.type}</div>
          {v.handover && <div><span className="muted">Handover</span> {v.handover.page ?? "—"} at {fmtTime(v.handover.at)}</div>}
          <div><span className="muted">Visit</span> {fmtTime(v.first_at)} → {fmtTime(v.last_at)}{v.settled ? "" : " (still open)"}</div>
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <h2>Why</h2>
          {v.reasons?.length ? <ul className="reason-list">{v.reasons.map((r) => <li key={r.code}><strong>{r.code}</strong> — {r.text}</li>)}</ul> : <p className="muted">No strong signals either way.</p>}
        </div>
        <div className="panel">
          <h2>Who drove each page</h2>
          {d.pages.length ? (
            <table>
              <thead><tr><th>Page</th><th>Driver</th><th>Signs</th></tr></thead>
              <tbody>{d.pages.map((p, i) => <tr key={i}><td>{p.path ?? "—"}</td><td><ControlChip mode={p.driver === "both" ? "mixed" : p.driver} /></td><td className="small">{[...p.agentSigns, ...p.humanSigns].join(", ") || "—"}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted">The page script didn't report on this visit.</p>}
        </div>
      </div>
      {d.assessments.length > 0 && (
        <div className="panel">
          <h2>Orders from this visit</h2>
          <table>
            <thead><tr><th>Order</th><th>Amount</th><th>Driven by</th><th>Suggested</th><th>Final</th></tr></thead>
            <tbody>{d.assessments.map((a) => <tr key={a.assessment_id}><td><Link to={`${base}/orders/${a.assessment_id}?mode=${mode}`}>{a.order_id}</Link></td><td>{fmtMoney(a.amount, a.currency)}</td><td><ControlChip mode={a.driver} /></td><td><ActionBadge action={a.suggested_action} /></td><td>{a.final ? "yes" : "not yet"}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="panel">
        <h2>Timeline</h2>
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Page</th></tr></thead>
          <tbody>{d.timeline.map((e, i) => <tr key={i}><td>{new Date(e.at).toLocaleTimeString()}</td><td>{e.kind === "event" ? e.name : e.kind === "assess" ? "assess at Pay" : e.kind}</td><td>{e.path ?? "—"}</td></tr>)}</tbody>
        </table>
      </div>
    </>
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
