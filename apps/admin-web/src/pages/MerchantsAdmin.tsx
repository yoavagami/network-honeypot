import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { adminMerchants, type PageHits, type MerchantRow, type Mode, type Overview, type VisitRow, type OrderRow, type OrderDetail } from "../merchantApi.js";
import type { AgentVisitDetail } from "../api.js";
import { VisitDetailBody } from "../components/VisitDetail.js";
import { ApiError } from "../api.js";
import { fmtTime, ModeToggle, OverviewPanels, OrdersTable, VisitsTable, ActionBadge, fmtMoney, MerchantVisitHeader, BUCKET_OPTIONS } from "../components/MerchantViews.js";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Request failed");

/** Merchants: access requests to approve, accounts, and invite links. Admins see every merchant. */
export function MerchantsPage() {
  const [rows, setRows] = useState<MerchantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; link?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => adminMerchants.list().then((r) => setRows(r.merchants)).catch((e) => setError(errText(e)));
  useEffect(() => { void load(); }, []);

  async function act(id: string, fn: () => Promise<unknown>, done: (r: any) => { text: string; link?: string }) {
    setBusy(id); setError(null); setNotice(null);
    try { setNotice(done(await fn())); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  }

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Merchants</h1>
        <Link to="/merchant-traffic">Merchant traffic →</Link>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {notice && (
        <div className="banner" style={{ marginBottom: "1rem" }}>
          {notice.text}
          {notice.link && (
            <div style={{ marginTop: ".5rem" }}>
              <code style={{ wordBreak: "break-all" }}>{notice.link}</code>{" "}
              <button onClick={() => void navigator.clipboard.writeText(notice.link!)}>Copy</button>
              <div className="muted small">Single use, valid 7 days. Send it to the merchant yourself — no email is sent.</div>
            </div>
          )}
        </div>
      )}
      <div className="panel">
        {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No merchants or access requests yet. Requests come from {location.origin.replace(/:\d+$/, "")}/merchants.</p> : (
          <table>
            <thead><tr><th>Merchant</th><th>Status</th><th>Website</th><th>Contact</th><th>Platform</th><th>Requested</th><th>Users</th><th>Domains</th><th>Visits 7d</th><th>Orders 7d</th><th>Last data</th><th></th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.merchant_id}>
                  <td><strong>{m.company}</strong><div className="muted small"><code>{m.merchant_id}</code></div></td>
                  <td><span className={`badge ${m.status === "approved" ? "low" : m.status === "pending" ? "medium" : "critical"}`}>{m.status}</span></td>
                  <td className="truncate">{m.website}</td>
                  <td className="truncate">{m.contact_email}</td>
                  <td>{m.platform}{m.monthly_checkouts ? <div className="muted small">{m.monthly_checkouts}</div> : null}</td>
                  <td>{fmtTime(m.created_at)}</td>
                  <td>{m.users}</td><td>{m.verified_domains}</td><td>{m.visits_7d}</td><td>{m.assessments_7d}</td>
                  <td>{fmtTime(m.last_event_at)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {m.status === "pending" && <>
                      <button disabled={busy === m.merchant_id} onClick={() => void act(m.merchant_id, () => adminMerchants.approve(m.merchant_id), (r) => ({ text: `Approved ${m.company}. Owner invite for ${r.invite_email}:`, link: r.invite_url }))}>Approve</button>{" "}
                      <button disabled={busy === m.merchant_id} onClick={() => void act(m.merchant_id, () => adminMerchants.decline(m.merchant_id), () => ({ text: `Declined ${m.company}.` }))}>Decline</button>
                    </>}
                    {m.status === "approved" && <>
                      <Link to={`/merchant-traffic?merchant_id=${m.merchant_id}`}>Traffic</Link>{" "}
                      <button disabled={busy === m.merchant_id} onClick={() => void act(m.merchant_id, () => adminMerchants.invite(m.merchant_id), (r) => ({ text: `New owner invite for ${r.invite_email}:`, link: r.invite_url }))}>New invite</button>{" "}
                      <button disabled={busy === m.merchant_id} onClick={() => { if (confirm(`Suspend ${m.company}? Their keys stop working and users are signed out.`)) void act(m.merchant_id, () => adminMerchants.setStatus(m.merchant_id, "suspended"), () => ({ text: `Suspended ${m.company}.` })); }}>Suspend</button>
                    </>}
                    {m.status === "suspended" && <button disabled={busy === m.merchant_id} onClick={() => void act(m.merchant_id, () => adminMerchants.setStatus(m.merchant_id, "approved"), () => ({ text: `Reactivated ${m.company}.` }))}>Reactivate</button>}
                    {m.status === "declined" && <button disabled={busy === m.merchant_id} onClick={() => void act(m.merchant_id, () => adminMerchants.approve(m.merchant_id), (r) => ({ text: `Approved ${m.company}. Owner invite for ${r.invite_email}:`, link: r.invite_url }))}>Approve</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <PageHitsPanel />
    </div>
  );
}

const PAGE_LABEL: Record<string, string> = {
  "/merchants": "Request access",
  "/docs/integrate": "Developer guide",
  "/integrate/v1/agent.md": "Agent file",
  "/llms.txt": "llms.txt",
};

/** Who opened the public merchant pages: request access, developer guide, agent file. */
function PageHitsPanel() {
  const [days, setDays] = useState(7);
  const [path, setPath] = useState("");
  const [data, setData] = useState<PageHits | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    adminMerchants.pageHits({ days, path: path || undefined }).then(setData).catch((e) => setError(errText(e)));
  }, [days, path]);
  return (
    <div className="panel">
      <div className="toolbar">
        <h2 style={{ marginRight: "auto", marginBottom: 0 }}>Who opened the merchant pages</h2>
        <select value={path} onChange={(e) => setPath(e.target.value)} aria-label="Page">
          <option value="">All pages</option>
          {Object.entries(PAGE_LABEL).map(([p, l]) => <option key={p} value={p}>{l}</option>)}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} day{d > 1 ? "s" : ""}</option>)}
        </select>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {!data ? !error && <p className="muted">Loading…</p> : (
        <>
          <div className="grid-3">
            <div>
              <h3>Pages</h3>
              {data.by_page.length === 0 ? <p className="muted">No hits.</p> : <ul>{data.by_page.map((p) => <li key={p.path}>{PAGE_LABEL[p.path] ?? p.path}: {p.hits} hits, {p.visitors} visitors <span className="muted small">(last {fmtTime(p.last_at)})</span></li>)}</ul>}
            </div>
            <div>
              <h3>Countries</h3>
              {data.by_country.length === 0 ? <p className="muted">—</p> : <ul>{data.by_country.map((c) => <li key={c.country}>{c.country}: {c.hits}</li>)}</ul>}
            </div>
            <div>
              <h3>Agents and tools</h3>
              {data.agents.length === 0 ? <p className="muted">Only browsers so far.</p> : <ul>{data.agents.map((a) => <li key={a.agent}>{a.agent}: {a.hits} <span className="muted small">(last {fmtTime(a.last_at)})</span></li>)}</ul>}
            </div>
          </div>
          {data.hits.length > 0 && (
            <table style={{ marginTop: "1rem" }}>
              <thead><tr><th>Time</th><th>Page</th><th>IP</th><th>Country</th><th>Network</th><th>Agent / tool</th><th>User agent</th><th>Referrer</th></tr></thead>
              <tbody>{data.hits.map((h, i) => (
                <tr key={i}>
                  <td>{fmtTime(h.created_at)}</td><td>{PAGE_LABEL[h.path] ?? h.path}{h.status !== 200 ? ` (${h.status})` : ""}</td>
                  <td>{h.ip ?? <span className="muted">cleared</span>}</td><td>{h.country ?? "—"}</td><td className="truncate">{h.network ?? "—"}</td>
                  <td>{h.agent ?? <span className="muted">browser</span>}</td><td className="truncate" title={h.user_agent ?? ""}>{h.user_agent ?? "—"}</td><td className="truncate">{h.referrer ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <p className="muted small" style={{ marginTop: ".5rem" }}>IP addresses are kept for 30 days. Recording started with this release; earlier visits are not included.</p>
        </>
      )}
    </div>
  );
}

/** Merchant traffic across all merchants, with a merchant filter. Every filtered view is access-logged. */
export function MerchantTrafficPage() {
  const [params, setParams] = useSearchParams();
  const merchantId = params.get("merchant_id") ?? "";
  // Test data until merchants go live: today every merchant integrates with test keys first.
  const mode = (params.get("mode") as Mode) ?? "test";
  const bucket = params.get("bucket") ?? "";
  const labOnly = params.get("lab") === "1";
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [data, setData] = useState<{ overview: Overview; visits: VisitRow[]; orders: OrderRow[] } | null>(null);
  const [tab, setTab] = useState<"visits" | "orders">("visits");
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };

  useEffect(() => { adminMerchants.list("approved").then((r) => setMerchants(r.merchants)).catch(() => {}); }, []);
  useEffect(() => {
    setData(null); setError(null);
    const p = { merchant_id: merchantId || undefined, mode };
    Promise.all([adminMerchants.overview(p), adminMerchants.visits({ ...p, bucket: bucket || undefined, lab: labOnly ? "1" : undefined }), adminMerchants.orders(p)])
      .then(([overview, v, o]) => setData({ overview, visits: v.visits, orders: o.orders }))
      .catch((e) => setError(errText(e)));
  }, [merchantId, mode, bucket, labOnly]);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Merchant traffic</h1>
        <select value={merchantId} onChange={(e) => set("merchant_id", e.target.value)} aria-label="Merchant">
          <option value="">All merchants</option>
          {merchants.map((m) => <option key={m.merchant_id} value={m.merchant_id}>{m.company} ({m.merchant_id})</option>)}
        </select>
        <select value={bucket} onChange={(e) => set("bucket", e.target.value)} aria-label="Recommendation">{BUCKET_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label className="small"><input type="checkbox" checked={labOnly} onChange={(e) => set("lab", e.target.checked ? "1" : "")} /> Lab runs only</label>
        <ModeToggle mode={mode} onChange={(m) => set("mode", m)} />
      </div>
      {error && <div className="banner warn">{error}</div>}
      {!data ? <p className="muted">Loading…</p> : <>
        <OverviewPanels data={data.overview} />
        <div className="tabs">
          <button className={tab === "visits" ? "active" : ""} onClick={() => setTab("visits")}>Visits</button>
          <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>Orders</button>
        </div>
        <div className="panel">
          {tab === "visits"
            ? <VisitsTable visits={data.visits} base="/merchant-traffic" showMerchant={!merchantId} showLab mode={mode} />
            : <OrdersTable orders={data.orders} base="/merchant-traffic" showMerchant={!merchantId} mode={mode} />}
        </div>
      </>}
    </div>
  );
}

export function MerchantTrafficVisitPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  // Test data until merchants go live: today every merchant integrates with test keys first.
  const mode = (params.get("mode") as Mode) ?? "test";
  const [d, setD] = useState<AgentVisitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { adminMerchants.visit(id!, mode).then(setD).catch((e) => setError(errText(e))); }, [id, mode]);
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Visit {d?.merchant ? `· ${d.merchant.company}` : ""}</h1><Link to={`/merchant-traffic?mode=${mode}`}>← Merchant traffic</Link></div>
      {error && <div className="banner warn">{error}</div>}
      {d && <MerchantVisitHeader v={d} showLab />}
      {d ? <VisitDetailBody v={d} variant="merchant-admin" orderLink={(a) => `/merchant-traffic/orders/${a}?mode=${mode}`} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}

export function MerchantTrafficOrderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  // Test data until merchants go live: today every merchant integrates with test keys first.
  const mode = (params.get("mode") as Mode) ?? "test";
  const [d, setD] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { adminMerchants.order(id!, mode).then(setD).catch((e) => setError(errText(e))); }, [id, mode]);
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Order {d ? `${d.response.order.id} · ${d.company}` : ""}</h1><Link to={`/merchant-traffic?mode=${mode}`}>← Merchant traffic</Link></div>
      {error && <div className="banner warn">{error}</div>}
      {d ? <OrderDetailView d={d} base="/merchant-traffic" mode={mode} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}

export function OrderDetailView({ d, base, mode }: { d: OrderDetail; base: string; mode: Mode }) {
  const r = d.response;
  return (
    <>
      <div className="panel verdict-hero">
        <div className="kv">
          <div><span className="muted">Suggested</span> <ActionBadge action={r.suggested_action} /></div>
          <div><span className="muted">Driven by</span> {r.driver}</div>
          <div><span className="muted">Agent</span> {r.agent ? `${r.agent.id}${r.agent.operator ? ` (${r.agent.operator})` : ""}${r.agent.verified ? ` — verified by ${r.agent.verification}` : " — not verified"}` : "—"}</div>
          <div><span className="muted">Score</span> {Math.round(r.score * 100)}% · {r.confidence} confidence</div>
          <div><span className="muted">Amount</span> {fmtMoney(r.order.amount, r.order.currency)}</div>
          <div><span className="muted">Verdict</span> {d.final ? "final" : "preliminary — the final one follows when the visit ends"}</div>
          <div><span className="muted">Session token</span> {d.token_status} · {d.header_count} headers · {d.server_ms} ms</div>
          {d.visit_id && <div><Link to={`${base}/visits/${d.visit_id}?mode=${mode}`}>Open the visit →</Link></div>}
        </div>
      </div>
      <div className="panel">
        <h2>Why</h2>
        <ul className="reason-list">{(r.reasons as Array<{ code: string; text: string }>).map((x) => <li key={x.code}><strong>{x.code}</strong> — {x.text}</li>)}</ul>
      </div>
      {d.feedback.length > 0 && (
        <div className="panel"><h2>Outcome reported</h2><ul>{d.feedback.map((f, i) => <li key={i}>{fmtTime(f.created_at)} — {f.outcome}{f.note ? `: ${f.note}` : ""}</li>)}</ul></div>
      )}
      <details className="panel"><summary>API response</summary><pre className="small" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(r, null, 2)}</pre></details>
    </>
  );
}
