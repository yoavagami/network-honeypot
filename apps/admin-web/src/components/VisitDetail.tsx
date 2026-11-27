import { Link } from "react-router-dom";
import type { AgentLadderRung, AgentVisitDetail } from "../api.js";
import { AgentBadge, ControlChip, ProbabilityBar, TYPE_LABEL } from "./AgentBadge.js";
import { ReasonList } from "./ReasonList.js";

/**
 * The body of a visit page, shared by the honeypot's Agents visit page and merchant visits
 * (admin Merchant traffic, merchant portal). Variants:
 *   honeypot        — everything, incl. TLS fingerprints, rendering ladder, requests.
 *   merchant-admin  — merchant visit for admins: everything merchant data has (raw details).
 *   merchant        — the merchant's own dashboard: plain findings, no IP, no weights.
 */
export type VisitVariant = "honeypot" | "merchant-admin" | "merchant";

export const RUNG_LABEL: Record<AgentLadderRung, string> = {
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

const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100); } catch { return `${(amount / 100).toFixed(2)} ${currency}`; }
};

export function VisitDetailBody({ v, variant, orderLink }: { v: AgentVisitDetail; variant: VisitVariant; orderLink?: (assessmentId: string) => string }) {
  const s = v.score;
  const fp = v.fingerprint;
  const beh = v.behavior;
  const sum = (k: string) => beh.reduce((a, b) => a + (Number(b.behavior?.[k]) || 0), 0);
  const clicks = beh.flatMap((b) => b.behavior?.clicks ?? []);
  const artifacts = [...(fp?.artifacts ?? []), ...beh.flatMap((b) => b.artifacts ?? [])];

  return (
    <>
      <div className="panel">
        <div className="verdict-hero">
          <div><div className="muted small">Recommendation</div><div className="big"><AgentBadge bucket={s.bucket} /></div></div>
          <div><div className="muted small">P(AI agent)</div><ProbabilityBar p={s.probability} /></div>
          <div><div className="muted small">Type</div><div><strong>{TYPE_LABEL[s.type] ?? s.type}</strong></div></div>
          <div><div className="muted small">Agent</div><div className="mono">{s.agent ?? "unknown"}</div></div>
          <div>
            <div className="muted small">Driven by</div>
            <div>
              <ControlChip mode={s.control.mode} handoverPath={s.control.handover?.path} />
              {s.control.handover && <div className="muted small">handover on <span className="mono">{s.control.handover.path}</span>{s.control.handover.at ? ` at ${new Date(s.control.handover.at).toLocaleTimeString()}` : ""}</div>}
            </div>
          </div>
          <div><div className="muted small">Basis</div><div>{s.proven ? "Proven identity" : `Evidence score — leans ${s.leaning}`}</div></div>
        </div>
        {!s.calibrated && !s.proven && variant !== "merchant" && <p className="muted small">Uncalibrated: weights are expert judgment until tuned on labeled runs.</p>}
        {v.unboundBeacons > 0 && <div className="banner warn">{v.unboundBeacons} page-script beacon{v.unboundBeacons === 1 ? "" : "s"} claimed page loads this visitor was never served — forged or replayed, so they are left out of the score below.</div>}
        {s.scorerVersion && variant === "honeypot" && <p className="muted small">Scored now with scorer {s.scorerVersion} (the Agents list shows the stored score, which can be up to ~30 s older).</p>}
      </div>

      <div className="panel">
        <h2>Why</h2>
        <ReasonList reasons={s.reasons} directionOnly={variant === "merchant"} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Network &amp; identity</h2>
          <dl className="kv">
            {variant !== "merchant" && <><dt>IP</dt><dd>{v.network.ip ?? "redacted"}</dd></>}
            {variant !== "honeypot" && <><dt>Country</dt><dd>{v.network.country ?? "—"}</dd></>}
            <dt>Network</dt><dd>{v.network.organization ?? "—"} {v.network.asn ? `(${v.network.asn})` : ""}</dd>
            {variant === "honeypot" ? <>
              <dt>JA4 (TLS)</dt><dd>{v.network.ja4.join(" ") || "—"}</dd>
              <dt>HTTP/2</dt><dd>{v.network.h2.join(" ") || "—"}</dd>
            </> : <><dt>TLS fingerprint</dt><dd className="muted">not available for merchant sites</dd></>}
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
              {variant !== "merchant" && <><dt>Injected globals</dt><dd>{(fp.globalsDiff ?? []).slice(0, 12).join(", ") || "none"}</dd></>}
              <dt>Agent page markers</dt><dd>{artifacts.length ? artifacts.map((a: any) => `${a.tag}#${a.id || a.cls}${a.known ? ` (${a.known})` : ""}`).join(", ") : "none"}</dd>
            </dl>
          )}
        </div>
      </div>

      {s.control.pages.length > 0 && (
        <div className="panel">
          <h2>Who was driving</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Each page load judged on its own: automation signs (clicks with no mouse path, form fields set by script, scrolling with no input) vs. human signs (mouse paths, wheel/trackpad, touch).
            {s.control.agentDriven && s.control.mode !== "agent" ? " Human-input credit from the person's pages isn't counted against the agent's evidence." : ""}
          </p>
          <table>
            <thead><tr><th>Page loaded</th><th>Page</th><th>Driver</th><th>Automation signs</th><th>Human signs</th></tr></thead>
            <tbody>
              {s.control.pages.map((p, i) => (
                <tr key={p.pl ?? i}>
                  <td>{p.at ? new Date(p.at).toLocaleTimeString() : "—"}</td>
                  <td className="mono">{p.path ?? "—"}</td>
                  <td className={`driver-${p.driver}`}>{p.driver === "both" ? "agent + human" : p.driver}</td>
                  <td className="cell-reason">{p.agentSigns.join("; ") || "—"}</td>
                  <td className="cell-reason">{p.humanSigns.join("; ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

      {variant !== "honeypot" && (
        <div className="panel">
          <h2>Rendering</h2>
          <p className="muted small" style={{ marginTop: 0 }}>The rendering ladder (CSS / noscript / JavaScript beacons) is only measured on uhoney.shop.</p>
          <p>Page script ran on this visit: <strong>{fp || beh.length ? "yes" : "no"}</strong>{!fp && !beh.length ? " — no JavaScript reported (a fetcher, a script, or the tag was blocked)" : ""}</p>
        </div>
      )}

      {variant === "honeypot" && s.ladder?.pages.length > 0 && (
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
            <dt>Clicks</dt><dd>{clicks.length} — {clicks.slice(0, 6).map((c: any) => variant === "merchant" ? `${c.target ?? "?"} (${c.trusted ? "real click" : "script-generated"}, ${c.movesLast1s} mouse moves before)` : `${c.target ?? "?"} (${c.trusted ? "trusted" : "SYNTHETIC"}, ${c.movesLast1s} moves before, offset ${c.dx ?? "?"},${c.dy ?? "?"})`).join("; ") || "none"}</dd>
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

      {v.merchant && v.merchant.assessments.length > 0 && (
        <div className="panel">
          <h2>Orders from this visit</h2>
          <table>
            <thead><tr><th>Order</th><th>Amount</th><th>Driven by</th><th>Decision</th><th>Final</th></tr></thead>
            <tbody>{v.merchant.assessments.map((a) => (
              <tr key={a.assessment_id}>
                <td>{orderLink ? <Link to={orderLink(a.assessment_id)}>{a.order_id}</Link> : a.order_id}</td>
                <td>{money(a.amount, a.currency)}</td><td><ControlChip mode={a.driver} /></td>
                <td>{a.decision ? <span className={`badge ${a.decision === "block" ? "critical" : a.decision === "confirm" ? "medium" : "low"}`}>{a.decision}</span> : "—"}</td>
                <td>{a.final ? "yes" : "not yet"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {v.merchant && (
        <div className="panel">
          <h2>Timeline</h2>
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Page</th></tr></thead>
            <tbody>{v.merchant.timeline.map((e, k) => (
              <tr key={k}><td>{new Date(e.at).toLocaleTimeString()}</td><td>{e.kind === "event" ? e.name : e.kind === "assess" ? "assess at Pay" : e.kind === "page" ? "page view" : e.kind}</td><td className="mono">{e.path ?? "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {variant !== "merchant" && v.requests.length > 0 && (
        <div className="panel">
        <h2>{variant === "honeypot" ? "Requests" : "Requests we saw (page-view beacons and the Pay check)"}</h2>
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
      )}
    </>
  );
}
