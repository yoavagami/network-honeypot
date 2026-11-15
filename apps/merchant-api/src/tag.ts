import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The merchant tag (/v1/tag.js): a small loader followed by the honeypot's existing page script
 * (apps/honeypot/static/app.js), with a handful of textual patches that point it at the merchant
 * API. The page script itself is unchanged — no new collection — so every improvement to it reaches
 * merchants with the next deploy. tag.test.ts fails if a patch target disappears from app.js.
 *
 * The loader adds what a merchant site needs and the honeypot doesn't:
 *   - the site key (data-site-key) and the API base (data-api, default from config)
 *   - consent mode (data-consent="pending" holds everything until uhoney.consent(true))
 *   - a page-view beacon per page and per single-page-app route change
 *   - the session token: kept in sessionStorage, added to forms as uhoney_token, uhoney.token()
 *   - uhoney.track(name, { orderId }) for pay_clicked and the other checkout events
 */
export const TAG_VERSION = "1.0.0";

const APP_JS = fileURLToPath(new URL("../../honeypot/static/app.js", import.meta.url));

export const PATCHES: Array<{ name: string; find: string; replace: string; all?: boolean }> = [
  { name: "endpoint", find: 'var ENDPOINT = "/api/v1/rum";', replace: "var ENDPOINT = __UH.endpoint;" },
  // No server-minted page-load id on a merchant page: use the tag's page-view id and skip the
  // honeypot-only rendering-ladder pixel (it is guarded by SERVER_PL).
  { name: "page-id", find: "var PL = SERVER_PL;", replace: "SERVER_PL = null; var PL = __UH.pl;" },
  { name: "beacon-body", find: "JSON.stringify({ v: 1, sdk: SDK, kind: kind,", replace: "JSON.stringify({ site_key: __UH.key, session_token: __UH.token() || undefined, v: 1, sdk: SDK, kind: kind," },
  // Merchant URLs can carry personal data in query strings: send the path only.
  { name: "path-only", find: "path: location.pathname + location.search", replace: "path: location.pathname", all: true },
  { name: "no-cookies", find: 'credentials: "same-origin"', replace: 'credentials: "omit"', all: true },
  { name: "start", find: 'if (document.readyState === "complete") start();\n  else window.addEventListener("load", start);', replace: '__UH.ready(function () { if (document.readyState === "complete") start(); else window.addEventListener("load", start); });' },
];

export function patchAppJs(source: string): string {
  let out = source;
  for (const p of PATCHES) {
    const count = out.split(p.find).length - 1;
    if (count === 0 || (!p.all && count !== 1)) throw new Error(`tag build: patch "${p.name}" expected ${p.all ? "at least one" : "exactly one"} match, found ${count}`);
    out = p.all ? out.split(p.find).join(p.replace) : out.replace(p.find, p.replace);
  }
  return out;
}

const loader = (apiBase: string) => `
  var __UH = (function () {
    var cs = document.currentScript;
    var KEY = cs && cs.getAttribute("data-site-key");
    if (!KEY || !/^pk_(test|live)_[A-Za-z0-9]{24}$/.test(KEY) || window.__uhoneyLoaded) return null;
    window.__uhoneyLoaded = true;
    var API = (cs.getAttribute("data-api") || ${JSON.stringify(apiBase)}).replace(/\\/+$/, "");
    var ENDPOINT = API + "/v1/collect";
    var STORE = "uhoney_st";
    var FIELD = "uhoney_token";
    var VERSION = "tag-${TAG_VERSION}";
    var consented = cs.getAttribute("data-consent") !== "pending";
    var token = null, started = false, readyCbs = [], pending = [], lastPath = location.pathname;
    try { token = sessionStorage.getItem(STORE); } catch (e) {}
    function rid() {
      var s = "pv_", a = new Uint8Array(12);
      try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < 12; j++) a[j] = Math.floor(Math.random() * 256); }
      for (var i = 0; i < a.length; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789".charAt(a[i] % 36);
      return s;
    }
    var pl = rid();
    function setToken(t) {
      token = t;
      try { sessionStorage.setItem(STORE, t); } catch (e) {}
      attachAll();
    }
    function attach(form) {
      if (!token || !form || form.tagName !== "FORM" || (form.method || "").toLowerCase() !== "post") return;
      var input = form.querySelector('input[name="' + FIELD + '"]');
      if (!input) { input = document.createElement("input"); input.type = "hidden"; input.name = FIELD; form.appendChild(input); }
      input.value = token;
    }
    function attachAll() { try { for (var i = 0; i < document.forms.length; i++) attach(document.forms[i]); } catch (e) {} }
    document.addEventListener("submit", function (e) { attach(e.target); }, true);
    function body(kind, data) {
      return { site_key: KEY, session_token: token || undefined, kind: kind, pl: pl, path: location.pathname, t: Math.max(0, Math.round(performance.now())), sdk: VERSION, data: data || {} };
    }
    function post(kind, data, done) {
      var b;
      try { b = JSON.stringify(body(kind, data)); } catch (e) { return; }
      try {
        fetch(ENDPOINT, { method: "POST", body: b, keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j && j.session_token) setToken(j.session_token); if (done) done(); })
          .catch(function () { if (done) done(); });
      } catch (e) { if (done) done(); }
    }
    function release() {
      if (started) return;
      started = true;
      var cbs = readyCbs; readyCbs = [];
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch (e) {} }
      var q = pending; pending = [];
      for (var k = 0; k < q.length; k++) track(q[k][0], q[k][1]);
    }
    function begin() {
      post("page", { spa: false }, release);
      // Never hold the page script back for long if the network is slow.
      setTimeout(release, 3000);
    }
    function routeChanged() {
      if (!consented || location.pathname === lastPath) return;
      lastPath = location.pathname;
      pl = rid();
      api.pl = pl;
      post("page", { spa: true });
    }
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function () { var r = orig.apply(this, arguments); try { routeChanged(); } catch (e) {} return r; };
    });
    window.addEventListener("popstate", routeChanged);
    function track(name, props) {
      if (!started) { pending.push([name, props]); return; }
      var orderId = props && (props.orderId || props.order_id);
      post("event", { name: String(name), order_id: orderId ? String(orderId).slice(0, 128) : undefined });
    }
    var prior = window.uhoney && window.uhoney.q;
    var api = {
      endpoint: ENDPOINT, key: KEY, pl: pl,
      token: function () { return token; },
      ready: function (cb) { if (started) cb(); else readyCbs.push(cb); }
    };
    window.uhoney = {
      version: VERSION,
      track: function (name, props) { if (consented) track(name, props); },
      token: function () { return token; },
      consent: function (granted) { if (granted && !consented) { consented = true; begin(); } }
    };
    if (prior && prior.length) for (var p = 0; p < prior.length; p++) { var call = prior[p]; if (call && call[0] === "track") window.uhoney.track(call[1], call[2]); else if (call && call[0] === "consent") window.uhoney.consent(call[1]); }
    if (token) attachAll();
    if (consented) begin();
    return api;
  })();
  if (!__UH) return;
`;

export interface BuiltTag { body: string; etag: string }

export function buildTag(apiBase: string, appJs = readFileSync(APP_JS, "utf8")): BuiltTag {
  const body = `/* uHoney tag ${TAG_VERSION} — https://uhoney.shop/docs/integrate */\n(function () {\n  "use strict";\n${loader(apiBase)}\n${patchAppJs(appJs)}\n})();\n`;
  return { body, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"` };
}
