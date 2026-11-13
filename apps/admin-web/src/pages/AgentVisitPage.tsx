import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type AgentLadderRung, type AgentVisitDetail } from "../api.js";
import { AgentBadge, ProbabilityBar, TYPE_LABEL } from "../components/AgentBadge.js";
import { ReasonList } from "../components/ReasonList.js";

const RUNG_LABEL: Record<AgentLadderRung, string> = {
  pending: "waiting for beacons",
  html_only: "HTML only",
  images_only: "HTML + images, no CSS",
  css_no_js: "rendered CSS, no JS",
  js_no_css: "ran JS, no CSS",
  ran_js: "ran JavaScript",
};

const cents = (c: unknown) => (typeof c === "number" ? `€${(c / 100).toFixed(2)}` : "—");

function shopDetail(type: string, d: Record<string, any> | null): string {
  if (!d) return "";
  switch (type) {
    case "SHOP_HOME_VIEW":
    case "SHOP_PRODUCT_VIEW":
      return (d.offers ?? []).map((o: any) => `${o.sku} ${cents(o.priceCents)}`).join(", ");
    case "SHOP_ADD_TO_CART":
      return `${d.qty} × ${d.sku} @ ${cents(d.unitCents)} → basket ${cents(d.totals?.totalCents)}`;
    case "SHOP_CART_UPDATE":
      return `${d.sku} → qty ${d.qty}; basket ${cents(d.totals?.totalCents)}`;
    case "SHOP_CHECKOUT_DETAILS":
    case "SHOP_CHECKOUT_DETAILS_INVALID":
      return `fields filled: ${Object.entries(d.filled ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${k}(${n})`).join(", ")} · email ${d.emailValid ? "valid" : "invalid"} · postcode ${d.postcodeMatchesCountry === false ? "doesn't match country" : "ok"}${d.missing?.length ? ` · missing ${d.missing.join(", ")}` : ""}`;
    case "SHOP_CHECKOUT_SHIPPING":
      return `${d.shipping} → total ${cents(d.totals?.totalCents)}`;
    case "SHOP_PAYMENT_ATTEMPT":
    case "SHOP_PAYMENT_DECLINED":
    case "SHOP_ORDER_PLACED": {
      const p = d.payment ?? {};
      const card = p.card_result ? ` · card: ${p.card_result}${p.card_brand ? ` (${p.card_brand})` : ""}${p.card_number_length ? `, ${p.card_number_length} digits, Luhn ${p.card_luhn_valid ? "valid" : "invalid"}` : ""}` : "";
      return `${d.method ?? ""} · ${d.status ?? ""} · total ${cents(d.totals?.totalCents)}${d.orderId ? ` · order ${d.orderId}` : ""}${card}`;
    }
    case "SHOP_CART_VIEW":
    case "SHOP_CHECKOUT_START":
    case "SHOP_SHIPPING_VIEW":
    case "SHOP_PAYMENT_VIEW":
      return `${(d.lines ?? []).map((l: any) => `${l.qty}×${l.sku}`).join(", ")} · total ${cents(d.totals?.totalCents)}`;
    default:
      return d.error ?? "";
  }
}

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
  const s = v.score;
  const fp = v.fingerprint;
  const beh = v.behavior;
  const sum = (k: string) => beh.reduce((a, b) => a + (Number(b.behavior?.[k]) || 0), 0);
  const clicks = beh.flatMap((b) => b.behavior?.clicks ?? []);
  const artifacts = [...(fp?.artifacts ?? []), ...beh.flatMap((b) => b.artifacts ?? [])];

  return (
    <div>
      <p><Link to="/agents">← Agents</Link></p>
      <h1>Visit <span className="mono">{v.id.slice(0, 40)}</span></h1>
      <p className="muted" style={{ marginTop: "-.5rem" }}>
        {new Date(v.firstAt).toLocaleString()} → {new Date(v.lastAt).toLocaleTimeString()} · {v.requestCount} requests · {v.network.organization ?? "unknown network"}
        {v.network.country ? ` · ${v.network.city ? `${v.network.city}, ` : ""}${v.network.country}` : ""} · <Link to={`/actors/${v.actorId}`}>actor {v.actorId.slice(0, 8)}</Link>
        {v.lab ? <> · lab label <strong className="mono">{v.lab}</strong></> : null}
      </p>

      <div className="panel">
        <div className="verdict-hero">
          <div><div className="muted small">Recommendation</div><div className="big"><AgentBadge bucket={s.bucket} /></div></div>
          <div><div className="muted small">P(AI agent)</div><ProbabilityBar p={s.probability} /></div>
          <div><div className="muted small">Type</div><div><strong>{TYPE_LABEL[s.type] ?? s.type}</strong></div></div>
          <div><div className="muted small">Agent</div><div className="mono">{s.agent ?? "unknown"}</div></div>
          <div><div className="muted small">Basis</div><div>{s.proven ? "Proven identity" : `Evidence score — leans ${s.leaning}`}</div></div>
        </div>
        {!s.calibrated && !s.proven && <p className="muted small">Uncalibrated: weights are expert judgment until tuned on labeled runs.</p>}
      </div>

      <div className="panel">
        <h2>Why</h2>
        <ReasonList reasons={s.reasons} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Network &amp; identity</h2>
          <dl className="kv">
            <dt>IP</dt><dd>{v.network.ip ?? "redacted"}</dd>
            <dt>Network</dt><dd>{v.network.organization ?? "—"} {v.network.asn ? `(${v.network.asn})` : ""}</dd>
            <dt>JA4 (TLS)</dt><dd>{v.network.ja4.join(" ") || "—"}</dd>
            <dt>HTTP/2</dt><dd>{v.network.h2.join(" ") || "—"}</dd>
            <dt>Web Bot Auth</dt><dd>{v.network.webBotAuth.join(", ") || "not signed"}</dd>
            <dt>User-agents</dt><dd>{v.network.userAgents.join(" | ") || "—"}</dd>
          </dl>
        </div>
        <div className="panel">
          <h2>Browser (page script)</h2>
          {!fp ? (
            <p className="muted">The page script never reported — no JavaScript ran in this visit.</p>
          ) : (
            <dl className="kv">
              <dt>webdriver</dt><dd>{String(fp.nav?.webdriver)}</dd>
              <dt>Automation globals</dt><dd>{(fp.automation?.globals ?? []).join(", ") || "none"}</dd>
              <dt>DevTools protocol</dt><dd>{String(fp.automation?.cdpRuntime)}</dd>
              <dt>GPU</dt><dd>{fp.webgl?.supported === false ? "no WebGL" : fp.webgl?.renderer ?? "—"}</dd>
              <dt>Window</dt><dd>{fp.screen ? `inner ${fp.screen.innerW}×${fp.screen.innerH}, outer ${fp.screen.outerW}×${fp.screen.outerH}, screen ${fp.screen.w}×${fp.screen.h} @${fp.screen.dpr}x` : "—"}</dd>
              <dt>Focus / visibility</dt><dd>{String(fp.doc?.hasFocus)} / {fp.doc?.visibility}</dd>
              <dt>Timezone / languages</dt><dd>{fp.intl?.tz} / {(fp.nav?.languages ?? []).join(", ")}</dd>
              <dt>Browser brands</dt><dd>{(fp.uaData?.fullVersionList ?? fp.uaData?.low?.brands ?? []).map((b: any) => `${b.brand} ${b.version}`).join(", ") || "—"}</dd>
              <dt>Injected globals</dt><dd>{(fp.globalsDiff ?? []).slice(0, 12).join(", ") || "none"}</dd>
              <dt>Agent page markers</dt><dd>{artifacts.length ? artifacts.map((a: any) => `${a.tag}#${a.id || a.cls}${a.known ? ` (${a.known})` : ""}`).join(", ") : "none"}</dd>
            </dl>
          )}
        </div>
      </div>

      {s.checks.length > 0 && (
        <div className="panel">
          <h2>Consistency checks (server vs. page)</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            What the page script reported compared with what the server saw for the same visit. Spoofing tools and cloud browsers usually patch one side only.
          </p>
          <table>
            <thead><tr><th>Check</th><th>Page says</th><th>Server says</th><th>Result</th></tr></thead>
            <tbody>
              {s.checks.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td className="mono cell-reason">{c.page ?? "—"}</td>
                  <td className="mono cell-reason">{c.server ?? "—"}</td>
                  <td><span className={`check-pill ${c.status}`}>{c.status === "match" ? "✓ match" : c.status === "mismatch" ? "✗ mismatch" : "? not compared"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s.ladder?.pages.length > 0 && (
        <div className="panel">
          <h2>Rendering ladder</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            How far the client got with each page: every page carries a CSS-only beacon, a &lt;noscript&gt; image and a JavaScript beacon.
            Overall: <strong>{RUNG_LABEL[s.ladder.summary ?? "pending"]}</strong>
          </p>
          <table>
            <thead><tr><th>Served</th><th>Page</th><th>CSS rendered</th><th>&lt;noscript&gt; image</th><th>JavaScript ran</th><th>Rung</th></tr></thead>
            <tbody>
              {s.ladder.pages.map((p) => (
                <tr key={p.pl}>
                  <td className="mono">{new Date(p.at).toLocaleTimeString()}</td>
                  <td className="mono cell-reason">{p.path}</td>
                  <td>{p.css ? "✓" : "—"}</td>
                  <td>{p.noscript ? "✓" : "—"}</td>
                  <td>{p.js ? "✓" : "—"}</td>
                  <td><span className={`check-pill ${p.rung === "ran_js" ? "match" : p.rung === "pending" ? "unknown" : "mismatch"}`}>{RUNG_LABEL[p.rung]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(fp || beh.length > 0) && (
        <div className="grid-2">
          <div className="panel">
            <h2>Environment</h2>
            <dl className="kv">
              <dt>Virtual-machine signs</dt><dd>{s.environment.tells.length ? s.environment.tells.join(", ") : "none"}</dd>
              <dt>Clock</dt><dd>{s.environment.utcTimezone ? "UTC (server default)" : fp?.intl?.tz ?? "—"}</dd>
              <dt>CPU / memory</dt><dd>{fp?.nav?.hardwareConcurrency ?? "?"} cores / {fp?.nav?.deviceMemory ?? "?"} GB</dd>
              <dt>Voices / media devices</dt><dd>{fp?.voices ?? "?"} / {fp?.devices ? Object.entries(fp.devices).map(([k, n]) => `${n} ${k}`).join(", ") || "none" : "?"}</dd>
              <dt>Page loads reported</dt><dd>{v.pageLoads ?? "—"}</dd>
            </dl>
          </div>
          <div className="panel">
            <h2>Input details</h2>
            <dl className="kv">
              <dt>Click placement</dt>
              <dd>
                {s.input.trustedClicks
                  ? `${s.input.centredClicks} of ${s.input.trustedClicks} clicks dead centre${s.input.clickSpread !== null ? ` · spread ${s.input.clickSpread} (0 = always centre, ≥0.12 = natural)` : ""}`
                  : "no clicks"}
              </dd>
              <dt>Think, then act</dt>
              <dd>
                {s.input.clickGaps
                  ? `${s.input.thinkPauses} of ${s.input.clickGaps} gaps between clicks were a still pause (≥2 s, cursor not moving) followed by a jump onto the target${s.input.medianThinkPauseMs ? ` · median pause ${(s.input.medianThinkPauseMs / 1000).toFixed(1)} s` : ""}`
                  : "fewer than two clicks on a page"}
              </dd>
              <dt>Typing</dt>
              <dd>{s.input.printableKeys} characters · {s.input.correctionKeys} corrections/arrows · {s.input.modifierKeys} modifier keys</dd>
              <dt>Pastes</dt><dd>{s.input.pastes}{s.input.pastes && !s.input.keyDowns ? " (with no key presses)" : ""}</dd>
            </dl>
          </div>
        </div>
      )}

      {beh.length > 0 && (
        <div className="panel">
          <h2>Behavior</h2>
          <dl className="kv">
            <dt>Mouse</dt><dd>{sum("mouseMoves")} moves, {Math.round(sum("mouseDistance"))} px travelled</dd>
            <dt>Clicks</dt><dd>{clicks.length} — {clicks.slice(0, 6).map((c: any) => `${c.target ?? "?"} (${c.trusted ? "trusted" : "SYNTHETIC"}, ${c.movesLast1s} moves before, offset ${c.dx ?? "?"},${c.dy ?? "?"})`).join("; ") || "none"}</dd>
            <dt>Keyboard</dt><dd>{sum("keyDowns")} key presses, {sum("inputWithoutKey")} text inputs without key presses</dd>
            <dt>Scrolling</dt><dd>{sum("scrolls")} scroll events, {sum("wheels")} wheel</dd>
            <dt>Visibility</dt><dd>{beh.map((b) => `${b.visibility}${b.focus === false ? " (unfocused)" : ""}`).join(" → ")}</dd>
          </dl>
        </div>
      )}

      {v.shopEvents.length > 0 && (
        <div className="panel">
          <h2>Shop journey</h2>
          <table>
            <thead><tr><th>Time</th><th>Step</th><th>Detail (prices shown / chosen)</th></tr></thead>
            <tbody>
              {v.shopEvents.map((e, i) => (
                <tr key={i}>
                  <td>{new Date(e.at).toLocaleTimeString()}</td>
                  <td className="mono">{e.type.replace("SHOP_", "").toLowerCase().replace(/_/g, " ")}</td>
                  <td>{shopDetail(e.type, e.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h2>Requests</h2>
        <table>
          <thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Identity verdict</th><th>Reason</th></tr></thead>
          <tbody>
            {v.requests.map((r) => (
              <tr key={r.requestId}>
                <td>{new Date(r.at).toLocaleTimeString()}</td>
                <td className="mono">{r.method} {r.path}{r.query ? `?${r.query}` : ""}</td>
                <td>{r.status}</td>
                <td className="mono">{r.verdict}{r.agent ? `:${r.agent}` : ""}</td>
                <td className="cell-reason">{r.reason}{r.flags.length ? ` (${r.flags.join(", ")})` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
