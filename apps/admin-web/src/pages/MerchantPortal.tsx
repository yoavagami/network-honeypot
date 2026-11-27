import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../api.js";
import { merchant, type DomainRow, type IntegrationStatus, type KeyRow, type MerchantMe, type Mode, type OrderDetail, type Overview, type Decision, type Policy, type PolicyCategory, type VisitRow, type OrderRow } from "../merchantApi.js";
import type { AgentVisitDetail } from "../api.js";
import { VisitDetailBody } from "../components/VisitDetail.js";
import { ChecklistView, fmtTime, ModeToggle, OrdersTable, OverviewPanels, VisitsTable, MerchantVisitHeader, BUCKET_OPTIONS } from "../components/MerchantViews.js";
import { OrderDetailView } from "./MerchantsAdmin.js";

/**
 * The merchant portal (/m/*): a merchant's own dashboard. Signs in against merchant-api, which
 * scopes every query to the signed-in merchant — there is no way to pick another merchant here.
 */
const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Request failed");

interface MerchantAuth { me: MerchantMe | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; mode: Mode; setMode: (m: Mode) => void }
const Ctx = createContext<MerchantAuth | null>(null);
export const useMerchant = () => useContext(Ctx)!;

export function MerchantAuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MerchantMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setModeState] = useState<Mode>(() => { try { return (localStorage.getItem("uh_mode") as Mode) || "test"; } catch { return "test"; } });
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem("uh_mode", m); } catch { /* storage blocked */ } };
  const refresh = () => merchant.me().then(setMe).catch(() => setMe(null));
  useEffect(() => { void refresh().finally(() => setLoading(false)); }, []);
  const logout = async () => { await merchant.logout().catch(() => {}); setMe(null); };
  return <Ctx.Provider value={{ me, loading, refresh, logout, mode, setMode }}>{children}</Ctx.Provider>;
}

export function RequireMerchant({ children }: { children: ReactNode }) {
  const { me, loading } = useMerchant();
  const location = useLocation();
  if (loading) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  if (!me) return <Navigate to="/m/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

const NAV = [
  { to: "/m", label: "Overview", end: true },
  { to: "/m/live", label: "Live" },
  { to: "/m/visits", label: "Visits" },
  { to: "/m/orders", label: "Orders" },
  { to: "/m/integration", label: "Integration" },
  { to: "/m/settings", label: "Settings" },
];

export function MerchantLayout() {
  const { me, logout, mode, setMode } = useMerchant();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">uHoney</div>
        <div className="muted small" style={{ padding: "0 1rem 1rem" }}>{me?.merchant.company}<br /><code>{me?.merchant.id}</code></div>
        <nav>{NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>{n.label}</NavLink>)}</nav>
        <div className="footer">
          <div style={{ marginBottom: ".5rem" }}>{me?.user.email}<div className="muted small">{me?.user.role}</div></div>
          <button onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <div className="toolbar" style={{ justifyContent: "flex-end" }}>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        {mode === "test" && <div className="banner" style={{ marginBottom: "1rem" }}>Showing <strong>test</strong> data (test keys, localhost). Switch to live data once your live keys are in use.</div>}
        <Outlet />
      </div>
    </div>
  );
}

function SafeTarget(from: unknown) {
  return typeof from === "string" && from.startsWith("/m") && !from.startsWith("//") && !from.startsWith("/m/login") ? from : "/m";
}

export function MerchantLoginPage() {
  const { refresh } = useMerchant();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await merchant.login(email, password);
      await refresh();
      navigate(SafeTarget((location.state as { from?: unknown } | null)?.from), { replace: true });
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>uHoney for merchants</h1>
        <form onSubmit={submit}>
          <input type="email" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          {error && <div className="error">{error}</div>}
          <button className="primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="muted small" style={{ marginTop: "1rem" }}>No account yet? <a href="/merchants">Request access</a>.</p>
      </div>
    </div>
  );
}

export function MerchantInvitePage() {
  const { token } = useParams();
  const { refresh } = useMerchant();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<{ company: string; email: string; role: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { merchant.invite(token!).then(setInvite).catch((e) => setError(errText(e))); }, [token]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) return setError("Use at least 12 characters.");
    if (!terms) return setError("Please accept the terms and the data processing agreement.");
    setBusy(true); setError(null);
    try { await merchant.acceptInvite(token!, name, password); await refresh(); navigate("/m/integration", { replace: true }); }
    catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Join uHoney</h1>
        {!invite && !error && <p className="muted">Checking your invite…</p>}
        {invite && <p>You're invited to <strong>{invite.company}</strong> as <strong>{invite.role}</strong> ({invite.email}).</p>}
        {invite && (
          <form onSubmit={submit}>
            <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            <input type="password" placeholder="Choose a password (12+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
            <label className="small" style={{ display: "flex", gap: ".5rem", alignItems: "flex-start", margin: ".5rem 0" }}>
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} style={{ width: "auto" }} />
              <span>I accept the uHoney terms of service and data processing agreement on behalf of {invite.company}.</span>
            </label>
            <button className="primary" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account"}</button>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => fn().then((d) => { setData(d); setError(null); }).catch((e) => setError(errText(e)));
  useEffect(() => { setData(null); void reload(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload };
}

export function MerchantOverviewPage() {
  const { mode } = useMerchant();
  const [days, setDays] = useState(7);
  const { data, error } = useLoad<Overview>(() => merchant.overview(mode, days), [mode, days]);
  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Agent traffic</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">{[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} day{d > 1 ? "s" : ""}</option>)}</select>
      </div>
      {error && <div className="banner warn">{error}</div>}
      {data ? (data.totals.visits === 0 ? <EmptyState /> : <OverviewPanels data={data} />) : !error && <p className="muted">Loading…</p>}
    </div>
  );
}

function EmptyState() {
  return <div className="panel"><h2>No visits yet</h2><p>Add the tag to your site and the first visits appear here within seconds. <Link to="/m/integration">Open the integration checklist →</Link></p></div>;
}

export function MerchantLivePage() {
  const { mode } = useMerchant();
  const [data, setData] = useState<Awaited<ReturnType<typeof merchant.live>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = () => merchant.live(mode).then((d) => { if (!stop) { setData(d); setError(null); } }).catch((e) => !stop && setError(errText(e)));
    void tick();
    const iv = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, [mode]);
  const agentsAtCheckout = data?.visits.filter((v) => v.reached_checkout && ["agent", "human_then_agent", "mixed", "agent_then_human"].includes(v.driver)) ?? [];
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Live</h1><span className="muted small">{data ? `updated ${new Date(data.at).toLocaleTimeString()} · refreshes every 5 s` : ""}</span></div>
      {error && <div className="banner warn">{error}</div>}
      {agentsAtCheckout.length > 0 && <div className="banner warn" style={{ marginBottom: "1rem" }}>{agentsAtCheckout.length} agent-driven visit{agentsAtCheckout.length > 1 ? "s" : ""} at checkout right now.</div>}
      <div className="panel"><h2>Active in the last 10 minutes</h2>{data ? <VisitsTable visits={data.visits} base="/m" mode={mode} /> : <p className="muted">Loading…</p>}</div>
      <div className="panel">
        <h2>Checkout and Pay events (30 minutes)</h2>
        {!data?.pay_events.length ? <p className="muted">None yet.</p> : (
          <table><thead><tr><th>Time</th><th>Event</th><th>Page</th><th></th></tr></thead>
            <tbody>{data.pay_events.map((e, i) => <tr key={i}><td>{new Date(e.created_at).toLocaleTimeString()}</td><td>{e.name ?? "assess at Pay"}</td><td>{e.path ?? "—"}</td><td>{e.visit_id ? <Link to={`/m/visits/${e.visit_id}?mode=${mode}`}>visit</Link> : <span className="muted">scoring…</span>}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function MerchantVisitsPage() {
  const { mode } = useMerchant();
  const [driver, setDriver] = useState("");
  const [agentsOnly, setAgentsOnly] = useState(false);
  const [bucket, setBucket] = useState("");
  const { data, error } = useLoad<{ visits: VisitRow[] }>(() => merchant.visits({ mode, driver: driver || undefined, agents: agentsOnly ? "1" : undefined, bucket: bucket || undefined }), [mode, driver, agentsOnly, bucket]);
  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Visits</h1>
        <select value={driver} onChange={(e) => setDriver(e.target.value)} aria-label="Driven by">
          <option value="">Any driver</option><option value="agent">Agent</option><option value="agent_then_human">Agent → human</option><option value="human_then_agent">Human → agent</option><option value="mixed">Mixed</option><option value="human">Human</option><option value="unknown">Unknown</option>
        </select>
        <select value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Recommendation">{BUCKET_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label className="small"><input type="checkbox" checked={agentsOnly} onChange={(e) => setAgentsOnly(e.target.checked)} /> Agents only</label>
      </div>
      {error && <div className="banner warn">{error}</div>}
      <div className="panel">{data ? <VisitsTable visits={data.visits} base="/m" mode={mode} /> : !error && <p className="muted">Loading…</p>}</div>
    </div>
  );
}

export function MerchantVisitPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const ctx = useMerchant();
  const mode = (params.get("mode") as Mode) ?? ctx.mode;
  const { data, error } = useLoad<AgentVisitDetail>(() => merchant.visit(id!, mode), [id, mode]);
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Visit</h1><Link to="/m/visits">← Visits</Link></div>
      {error && <div className="banner warn">{error}</div>}
      {data && <MerchantVisitHeader v={data} />}
      {data ? <VisitDetailBody v={data} variant="merchant" orderLink={(a) => `/m/orders/${a}?mode=${mode}`} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}

export function MerchantOrdersPage() {
  const { mode } = useMerchant();
  const [decision, setDecision] = useState("");
  const { data, error } = useLoad<{ orders: OrderRow[] }>(() => merchant.orders({ mode, decision: decision || undefined }), [mode, decision]);
  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Orders assessed at Pay</h1>
        <select value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Decision"><option value="">Any decision</option><option value="allow">allow</option><option value="confirm">confirm</option><option value="block">block</option></select>
      </div>
      {error && <div className="banner warn">{error}</div>}
      <div className="panel">{data ? <OrdersTable orders={data.orders} base="/m" mode={mode} /> : !error && <p className="muted">Loading…</p>}</div>
    </div>
  );
}

export function MerchantOrderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const ctx = useMerchant();
  const mode = (params.get("mode") as Mode) ?? ctx.mode;
  const { data, error, reload } = useLoad<OrderDetail>(() => merchant.order(id!, mode), [id, mode]);
  // Owners and developers can set the outcome; analysts only read it.
  const canSet = ctx.me?.user.role === "owner" || ctx.me?.user.role === "developer";
  const setOutcome = async (outcome: string, note: string) => { await merchant.setOutcome(id!, mode, outcome, note); await reload(); };
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Order {data?.response.order.id ?? ""}</h1><Link to="/m/orders">← Orders</Link></div>
      {error && <div className="banner warn">{error}</div>}
      {data ? <OrderDetailView d={data} base="/m" mode={mode} onSetOutcome={canSet ? setOutcome : undefined} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}

export function MerchantIntegrationPage() {
  const { mode } = useMerchant();
  const status = useLoad<IntegrationStatus>(() => merchant.integration(mode), [mode]);
  const keys = useLoad(() => merchant.keys(), []);
  const pk = keys.data?.keys.find((k) => k.kind === "public" && k.livemode === (mode === "live") && !k.revoked_at);
  const tagUrl = keys.data ? `${keys.data.tag_base_url}/v1/tag.js` : "";
  const docs = keys.data ? `${keys.data.tag_base_url}/docs/integrate` : "/docs/integrate";
  const agent = keys.data ? `${keys.data.tag_base_url}/integrate/v1/agent.md` : "";
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Integration</h1><button onClick={() => void status.reload()}>Re-check</button></div>
      <div className="grid-2">
        <div className="panel">
          <h2>1. Tag for every page</h2>
          {pk ? <pre className="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`<script async src="${tagUrl}" data-site-key="${pk.public_value}"></script>`}</pre> : <p className="muted">{mode === "live" ? "Live keys appear once a domain is verified (Settings → Domains)." : "Loading…"}</p>}
          <h2>2. Your IDs</h2>
          <p className="small">Merchant ID <code>{keys.data?.merchant_id}</code>. Secret keys: <Link to="/m/settings">Settings → Keys</Link> (shown once, keep them in your server environment).</p>
        </div>
        <div className="panel">
          <h2>Guides</h2>
          <p>Step by step for developers: <a href={docs} target="_blank" rel="noreferrer">{docs}</a></p>
          <p>Or tell your coding agent:</p>
          <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{`Integrate uHoney using ${agent}`}</pre>
          <p className="muted small">Put UHONEY_SITE_KEY and UHONEY_SECRET_KEY (test keys first) in the project's .env before you start.</p>
        </div>
      </div>
      <div className="panel">
        <h2>Checklist ({mode})</h2>
        {status.error && <div className="banner warn">{status.error}</div>}
        {status.data ? <ChecklistView status={status.data} /> : !status.error && <p className="muted">Loading…</p>}
      </div>
    </div>
  );
}

export function MerchantSettingsPage() {
  const { me } = useMerchant();
  const [tab, setTab] = useState<"keys" | "domains" | "webhooks" | "team" | "policy">("keys");
  return (
    <div>
      <div className="toolbar"><h1 style={{ marginRight: "auto" }}>Settings</h1></div>
      <div className="tabs">{(["keys", "domains", "webhooks", "team", "policy"] as const).map((t) => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
      {me?.user.role === "analyst" && <div className="banner" style={{ marginBottom: "1rem" }}>Analysts can view settings but not change them.</div>}
      {tab === "keys" && <KeysTab />}
      {tab === "domains" && <DomainsTab />}
      {tab === "webhooks" && <WebhooksTab />}
      {tab === "team" && <TeamTab />}
      {tab === "policy" && <PolicyTab />}
    </div>
  );
}

function Secret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <div className="banner warn" style={{ marginBottom: "1rem" }}>
      <strong>{label}</strong> — shown once. Copy it into your server environment now.
      <div style={{ margin: ".5rem 0" }}><code style={{ wordBreak: "break-all" }}>{value}</code> <button onClick={() => void navigator.clipboard.writeText(value)}>Copy</button></div>
      <button onClick={onDone}>I've stored it</button>
    </div>
  );
}

function KeysTab() {
  const { data, error, reload } = useLoad(() => merchant.keys(), []);
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async (kind: "public" | "secret", mode: Mode) => { setErr(null); try { const r = await merchant.createKey(kind, mode); if (kind === "secret") setSecret(r.value); await reload(); } catch (e) { setErr(errText(e)); } };
  const revoke = async (k: KeyRow) => { if (!confirm(`Revoke ${k.display}? Anything using it stops working immediately.`)) return; setErr(null); try { await merchant.revokeKey(k.key_id); await reload(); } catch (e) { setErr(errText(e)); } };
  return (
    <div className="panel">
      {secret && <Secret label="New secret key" value={secret} onDone={() => setSecret(null)} />}
      {(err || error) && <div className="banner warn">{err ?? error}</div>}
      <div className="toolbar">
        <button onClick={() => void create("secret", "test")}>Create test secret key</button>
        <button onClick={() => void create("secret", "live")}>Create live secret key</button>
        <button onClick={() => void create("public", "test")}>New test site key</button>
      </div>
      {data && (
        <table>
          <thead><tr><th>Key</th><th>Kind</th><th>Mode</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.keys.map((k) => (
            <tr key={k.key_id}>
              <td><code style={{ wordBreak: "break-all" }}>{k.public_value ?? k.display}</code></td><td>{k.kind}</td><td>{k.livemode ? "live" : "test"}</td>
              <td>{fmtTime(k.created_at)}</td><td>{fmtTime(k.last_used_at)}</td><td>{k.revoked_at ? <span className="muted">revoked</span> : "active"}</td>
              <td>{!k.revoked_at && <button onClick={() => void revoke(k)}>Revoke</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <p className="muted small">Rotate a secret key without downtime: create a new one, deploy it, then revoke the old one. At most two active keys per kind and mode.</p>
    </div>
  );
}

function DomainsTab() {
  const { data, error, reload } = useLoad(() => merchant.domains(), []);
  const [host, setHost] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: FormEvent) => { e.preventDefault(); setMsg(null); try { await merchant.addDomain(host); setHost(""); await reload(); } catch (err) { setMsg(errText(err)); } };
  const verify = async (d: DomainRow) => { setMsg(null); try { const r = await merchant.verifyDomain(d.domain_id); setMsg(r.verified ? `${d.host} verified${r.method ? ` by ${r.method}` : ""}. Live keys are available.` : r.error ?? `Not found yet. DNS changes can take a few minutes.`); await reload(); } catch (err) { setMsg(errText(err)); } };
  const remove = async (d: DomainRow) => { if (!confirm(`Remove ${d.host}? The tag stops accepting beacons from it.`)) return; try { await merchant.removeDomain(d.domain_id); await reload(); } catch (err) { setMsg(errText(err)); } };
  return (
    <div className="panel">
      {(msg || error) && <div className="banner" style={{ marginBottom: "1rem" }}>{msg ?? error}</div>}
      <form className="toolbar" onSubmit={add}><input placeholder="shop.example.com" value={host} onChange={(e) => setHost(e.target.value)} required /><button type="submit">Add domain</button></form>
      <p className="muted small">Test keys accept beacons from any registered domain and from localhost. Live keys only from verified domains.</p>
      {data && (
        <table>
          <thead><tr><th>Domain</th><th>Status</th><th>Verify with one of these</th><th></th></tr></thead>
          <tbody>{data.domains.map((d) => (
            <tr key={d.domain_id}>
              <td>{d.host}</td>
              <td>{d.verified_at ? <span className="badge low">verified ({d.verified_method})</span> : <span className="badge medium">not verified</span>}</td>
              <td className="small">{d.verified_at ? "—" : <>DNS TXT on {d.host}: <code>{d.txt_record}</code><br />or in the home page &lt;head&gt;: <code>{d.meta_tag}</code></>}</td>
              <td style={{ whiteSpace: "nowrap" }}>{!d.verified_at && <button onClick={() => void verify(d)}>Verify</button>} <button onClick={() => void remove(d)}>Remove</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function WebhooksTab() {
  const { mode } = useMerchant();
  const { data, error, reload } = useLoad(() => merchant.webhooks(mode), [mode]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (e: FormEvent) => { e.preventDefault(); setMsg(null); try { const r = await merchant.addWebhook(url, mode); setSecret(r.secret); setUrl(""); await reload(); } catch (err) { setMsg(errText(err)); } };
  return (
    <div className="panel">
      {secret && <Secret label="Webhook signing secret (UHONEY_WEBHOOK_SECRET)" value={secret} onDone={() => setSecret(null)} />}
      {(msg || error) && <div className="banner warn">{msg ?? error}</div>}
      <form className="toolbar" onSubmit={add}><input placeholder="https://shop.example.com/webhooks/uhoney" value={url} onChange={(e) => setUrl(e.target.value)} required style={{ minWidth: "22rem" }} /><button type="submit">Add {mode} endpoint</button></form>
      {data && <>
        <table>
          <thead><tr><th>URL</th><th>Secret</th><th>Events</th><th></th></tr></thead>
          <tbody>{data.endpoints.map((e) => (
            <tr key={e.endpoint_id}><td className="truncate">{e.url}</td><td><code>{e.secret_display}</code></td><td className="small">{e.events.join(", ")}</td>
              <td style={{ whiteSpace: "nowrap" }}><button onClick={() => void merchant.testWebhook(e.endpoint_id).then(() => setMsg("Test webhook queued — it is sent within a few seconds.")).then(reload)}>Send test webhook</button> <button onClick={() => void merchant.removeWebhook(e.endpoint_id).then(reload)}>Remove</button></td></tr>
          ))}</tbody>
        </table>
        <h3 style={{ marginTop: "1rem" }}>Recent deliveries</h3>
        {data.deliveries.length === 0 ? <p className="muted">None yet.</p> : (
          <table><thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last result</th></tr></thead>
            <tbody>{data.deliveries.map((d) => <tr key={d.event_id}><td>{fmtTime(d.created_at)}</td><td>{d.type}{d.is_test ? " (test)" : ""}</td><td>{d.status}</td><td>{d.attempts}</td><td className="small">{d.last_error ?? (d.last_status ? `HTTP ${d.last_status}` : "—")}</td></tr>)}</tbody>
          </table>
        )}
      </>}
    </div>
  );
}

function TeamTab() {
  const { me } = useMerchant();
  const { data, error, reload } = useLoad(() => merchant.team(), []);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("developer");
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const invite = async (e: FormEvent) => { e.preventDefault(); setMsg(null); try { const r = await merchant.inviteUser(email, role); setLink(r.invite_url); setEmail(""); await reload(); } catch (err) { setMsg(errText(err)); } };
  return (
    <div className="panel">
      {(msg || error) && <div className="banner warn">{msg ?? error}</div>}
      {link && <div className="banner" style={{ marginBottom: "1rem" }}>Invite link (single use, 7 days): <code style={{ wordBreak: "break-all" }}>{link}</code> <button onClick={() => void navigator.clipboard.writeText(link)}>Copy</button></div>}
      {me?.user.role === "owner" && (
        <form className="toolbar" onSubmit={invite}>
          <input type="email" placeholder="colleague@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="developer">developer</option><option value="analyst">analyst</option><option value="owner">owner</option></select>
          <button type="submit">Create invite</button>
        </form>
      )}
      <p className="muted small">Owner: everything. Developer: keys, domains, webhooks and data. Analyst: read-only.</p>
      {data && <>
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>{data.users.map((u) => (
            <tr key={u.user_id}><td>{u.email}{u.disabled ? <span className="muted"> (disabled)</span> : null}</td><td>{u.name}</td><td>{u.role}</td><td>{fmtTime(u.last_login_at)}</td>
              <td>{me?.user.role === "owner" && u.email !== me.user.email && <button onClick={() => void merchant.updateUser(u.user_id, { disabled: !u.disabled }).then(reload)}>{u.disabled ? "Enable" : "Disable"}</button>}</td></tr>
          ))}</tbody>
        </table>
        {data.invites.length > 0 && <p className="small" style={{ marginTop: ".75rem" }}>Pending invites: {data.invites.map((i) => `${i.email} (${i.role})`).join(", ")}</p>}
      </>}
    </div>
  );
}

const POLICY_LABELS: Record<PolicyCategory, string> = {
  spoofed_agent: "A spoofed agent (claims to be a known agent and fails its check)",
  verified_agent: "A verified agent (signed, or from its operator's published IPs)",
  unverified_agent: "An unverified agent drove the checkout",
  agent_then_human: "An agent browsed, then a person paid",
  uncertain: "Not sure (score between 35% and 70%)",
};


function PolicyTab() {
  const { me } = useMerchant();
  const { data, error } = useLoad(() => merchant.policy(), []);
  const [p, setP] = useState<Policy | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (data) setP(data.policy); }, [data]);
  if (error) return <div className="banner warn">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;
  const save = async () => { setMsg(null); try { await merchant.savePolicy(p); setMsg("Saved. New assessments use this policy."); } catch (e) { setMsg(errText(e)); } };
  return (
    <div className="panel">
      <p>The <code>decision</code> uHoney returns at Pay for each situation: <code>allow</code>, <code>confirm</code> (your checkout should get the shopper's own approval of the cart before charging) or <code>block</code>. The default never blocks. Your checkout decides what each one triggers.</p>
      <table>
        <tbody>{(Object.keys(POLICY_LABELS) as PolicyCategory[]).map((k) => (
          <tr key={k}><td>{POLICY_LABELS[k]}</td><td>
            <select value={p[k]} disabled={me?.user.role !== "owner"} onChange={(e) => setP({ ...p, [k]: e.target.value as Decision })}><option>allow</option><option>confirm</option><option>block</option></select>
            {data && data.default[k] !== p[k] && <span className="muted small"> (default: {data.default[k]})</span>}
          </td></tr>
        ))}</tbody>
      </table>
      {me?.user.role === "owner" && <button style={{ marginTop: "1rem" }} onClick={() => void save()}>Save policy</button>}
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
