import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FastifyInstance } from "fastify";
import { createTestDatabase, testPgUrl, type TestDatabase } from "@honeypot/merchant-db/src/testing.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { NetworkLookup } from "../src/sensing.js";
import { runScoringTick } from "../src/scoring/worker.js";
import { dispatchDue } from "../src/webhooks/dispatcher.js";
import { verifySignature } from "../src/webhooks/sign.js";
import { signLabToken } from "@honeypot/detection";

const spec = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/merchant-contract/openapi.json", import.meta.url)), "utf8"));
const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
(addFormats as any)(ajv);
ajv.addSchema({ $id: "oa", components: spec.components });
const matches = (schema: string, value: unknown) => {
  const v = ajv.getSchema(`oa#/components/schemas/${schema}`)!;
  const ok = v(value);
  if (!ok) throw new Error(`${schema}: ${JSON.stringify(v.errors)}`);
  return true;
};

const INTERNAL = "i".repeat(40);
const LAB_SECRET = "l".repeat(40);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

describe.skipIf(!testPgUrl)("merchant flow end to end", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  const A: any = {};
  const B: any = {};

  const cookieHeader = (res: any) => (res.cookies as Array<{ name: string; value: string }>).map((c) => `${c.name}=${c.value}`).join("; ");
  const internal = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, headers: { "x-internal-token": INTERNAL, "x-admin-user": "tester" } });
  const dash = (m: any, method: string, url: string, payload?: object) => app.inject({ method: method as any, url, payload, headers: { cookie: m.cookie, "x-csrf-token": m.csrf } });
  const collect = (m: any, body: object, origin = "http://localhost:3000") =>
    app.inject({ method: "POST", url: "/v1/collect", payload: JSON.stringify({ site_key: m.pk, ...body }), headers: { "content-type": "text/plain", origin, "user-agent": CHROME, "accept-language": "en-GB" } });
  const server = (m: any, method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${m.sk}`, ...headers } });

  async function onboard(m: any, company: string, email: string) {
    const r = await app.inject({ method: "POST", url: "/m/api/request-access", payload: { company, website: `${company}.test`, email, platform: "custom" }, remoteAddress: `10.0.0.${company.length}` });
    expect(r.statusCode).toBe(202);
    const list = (await internal("GET", "/internal/merchants?status=pending")).json().merchants;
    m.id = list.find((x: any) => x.company === company).merchant_id;
    const ap = await internal("POST", `/internal/merchants/${m.id}/approve`);
    expect(ap.statusCode).toBe(200);
    const token = ap.json().invite_url.split("/m/invite/")[1];
    expect((await app.inject({ method: "GET", url: `/m/api/invites/${token}` })).json()).toMatchObject({ company, role: "owner", email });
    const acc = await app.inject({ method: "POST", url: `/m/api/invites/${token}/accept`, payload: { name: "Owner", password: "correct horse battery", accept_terms: true } });
    expect(acc.statusCode).toBe(200);
    m.cookie = cookieHeader(acc);
    m.csrf = acc.json().csrf;
    expect((await app.inject({ method: "POST", url: `/m/api/invites/${token}/accept`, payload: { name: "Again", password: "correct horse battery", accept_terms: true } })).statusCode).toBe(404);
    const sk = await dash(m, "POST", "/m/api/keys", { kind: "secret", mode: "test" });
    expect(sk.statusCode).toBe(201);
    m.sk = sk.json().value;
    m.pk = (await dash(m, "GET", "/m/api/keys")).json().keys.find((k: any) => k.kind === "public" && !k.livemode).public_value;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const config = loadConfig({
      MERCHANT_APP_DATABASE_URL: db.urls.app, MERCHANT_ADMIN_DATABASE_URL: db.urls.admin,
      MERCHANT_TOKEN_SECRET: "t".repeat(40), MERCHANT_ENCRYPTION_KEY: "e".repeat(64), IP_HASH_SECRET: "h".repeat(32),
      MERCHANT_INTERNAL_TOKEN: INTERNAL, MERCHANT_COOKIE_SECURE: "false", MERCHANT_DASHBOARD_URL: "https://app.example.test", LAB_LINK_SECRET: LAB_SECRET,
    });
    app = await buildApp({ config, app: db.app, admin: db.admin, network: new NetworkLookup(null) });
    await onboard(A, "alpha", "owner@alpha.test");
    await onboard(B, "bravo", "owner@bravo.test");
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.drop(); });

  it("collect: localhost works with test keys, other origins and secret keys are refused", async () => {
    const page = await collect(A, { kind: "page", pl: "pv_aaaaaaaaaaaa", path: "/products/1?email=x@y.z", t: 5, data: {} });
    expect(page.statusCode).toBe(200);
    expect(matches("CollectResponse", page.json())).toBe(true);
    expect(page.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    A.token = page.json().session_token;
    const evil = await collect(A, { kind: "page", pl: "pv_aaaaaaaaaaaa", path: "/" }, "https://evil.test");
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe("origin_not_allowed");
    const wrong = await app.inject({ method: "POST", url: "/v1/collect", payload: JSON.stringify({ site_key: A.sk, kind: "page" }), headers: { "content-type": "text/plain", origin: "http://localhost:3000" } });
    expect(wrong.statusCode).toBe(400);
    const badEvent = await collect(A, { kind: "event", data: { name: "keylogger" } });
    expect(badEvent.statusCode).toBe(400);
  });

  it("collect keeps one session across a visit and stores the path without its query", async () => {
    const t = A.token;
    for (const [i, path] of ["/products/1", "/cart", "/checkout"].entries()) {
      const r = await collect(A, { kind: "page", session_token: t, pl: `pv_page${i}xxxxxx`, path, t: 10 });
      expect(r.statusCode).toBe(200);
    }
    await collect(A, { kind: "behavior", session_token: t, pl: "pv_page2xxxxxx", path: "/checkout", t: 900, data: { clicks: [] } });
    await collect(A, { kind: "event", session_token: t, pl: "pv_page2xxxxxx", path: "/checkout", data: { name: "pay_clicked", order_id: "ord_1" } });
    const sessions = await db.admin`SELECT DISTINCT session_id FROM merchant_events WHERE merchant_id = ${A.id}`;
    expect(sessions.length).toBe(1);
    const paths = await db.admin`SELECT path FROM merchant_events WHERE merchant_id = ${A.id} AND kind = 'page' ORDER BY created_at`;
    expect(paths[0]!.path).toBe("/products/1");
  });

  it("assess returns a contract-valid verdict, is idempotent, and refuses a reused key with another body", async () => {
    const body = { session_token: A.token, order: { id: "ord_1", amount: 12900, currency: "EUR" }, request: { ip: "203.0.113.7", user_agent: CHROME, headers: { accept: "*/*", "accept-language": "en-GB", "sec-fetch-site": "same-origin", cookie: "secret=1" } } };
    const r = await server(A, "POST", "/v1/assess", body);
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(matches("Assessment", a)).toBe(true);
    expect(a).toMatchObject({ merchant_id: A.id, livemode: false, final: false, order: body.order });
    A.assessment = a.assessment_id;
    const again = await server(A, "POST", "/v1/assess", body);
    expect(again.json()).toEqual(a);
    const conflict = await server(A, "POST", "/v1/assess", { ...body, order: { ...body.order, amount: 1 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_conflict");
    const [row] = await db.admin`SELECT token_status, header_count, data FROM assessments a JOIN merchant_events e ON e.kind = 'assess' AND e.merchant_id = a.merchant_id WHERE a.assessment_id = ${a.assessment_id}`;
    expect(row!.token_status).toBe("valid");
    expect(row!.header_count).toBe(3);
  });

  it("assess without a token rests on server signals and says so", async () => {
    const r = await server(A, "POST", "/v1/assess", { order: { id: "ord_2", amount: 4900, currency: "USD" }, request: { ip: "198.51.100.9", user_agent: "python-httpx/0.27.0", headers: {} } });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(matches("Assessment", a)).toBe(true);
    expect(a.signals_used.client).toBe(false);
    expect(a.reasons[0].code).toBe("no_client_signals");
    // An HTTP library with no AI evidence: automated, but the scorer caps it below "agent".
    expect(a.score).toBeGreaterThan(0.35);
    expect(a.automation_type).not.toBe("human");
    const bad = await server(A, "POST", "/v1/assess", { session_token: "st_" + "x".repeat(20) + "." + "y".repeat(20), order: { id: "ord_3", amount: 1, currency: "USD" }, request: { ip: "198.51.100.9", user_agent: CHROME, headers: {} } });
    expect(bad.json().reasons.map((x: any) => x.code)).toContain("session_token_invalid");
  });

  it("server endpoints: errors follow the contract", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/assess", payload: {} })).json().error.code).toBe("invalid_key");
    expect((await server({ sk: A.pk }, "POST", "/v1/assess", {})).json().error.code).toBe("wrong_key_type");
    expect((await server(A, "POST", "/v1/assess", { order: {} })).statusCode).toBe(400);
    const mismatch = await server(A, "GET", "/v1/integration/status", undefined, { "uhoney-merchant": B.id });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().error.code).toBe("merchant_mismatch");
    expect(matches("Error", mismatch.json())).toBe(true);
  });

  it("server calls record when the secret key was last used", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const [k] = await db.admin`SELECT last_used_at FROM api_keys WHERE merchant_id = ${A.id} AND kind = 'secret' AND revoked_at IS NULL ORDER BY created_at LIMIT 1`;
    expect(k!.last_used_at).not.toBeNull();
  });

  it("feedback attaches to the order's assessment", async () => {
    const r = await server(A, "POST", "/v1/feedback", { order_id: "ord_1", outcome: "confirmed_human" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ received: true, assessment_id: A.assessment });
    expect((await server(A, "POST", "/v1/feedback", { order_id: "nope", outcome: "fraud" })).statusCode).toBe(404);
  });

  it("the scoring worker stores visits and the dashboard shows them", async () => {
    const res = await runScoringTick(db.admin, new Date(Date.now() - 3600_000));
    expect(res.sessions).toBeGreaterThan(0);
    const visits = (await dash(A, "GET", "/m/api/visits")).json().visits;
    expect(visits.length).toBeGreaterThanOrEqual(2);
    expect(visits.every((v: any) => v.merchant_id === A.id)).toBe(true);
    const browsing = visits.find((v: any) => v.page_count >= 3);
    expect(browsing.reached_pay).toBe(true);
    const detail = await dash(A, "GET", `/m/api/visits/${browsing.visit_id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().merchant.timeline.length).toBeGreaterThan(3);
    const ov = (await dash(A, "GET", "/m/api/overview")).json();
    expect(ov.totals.visits).toBe(visits.length);
    expect(ov.orders.assessed).toBe(3);
  });

  it("webhooks are signed with the endpoint's secret and recorded as delivered", async () => {
    const ep = await dash(A, "POST", "/m/api/webhooks", { url: "https://hooks.alpha.test/uhoney", mode: "test" });
    expect(ep.statusCode).toBe(201);
    const secret = ep.json().secret;
    expect((await dash(A, "POST", `/m/api/webhooks/${ep.json().endpoint_id}/test`)).statusCode).toBe(202);
    const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const r = await dispatchDue(db.admin, { encryptionKey: "e".repeat(64), send: async (o: any) => { sent.push(o); return { status: 200, body: "" }; } });
    expect(r.sent).toBe(1);
    expect(sent[0]!.url).toBe("https://hooks.alpha.test/uhoney");
    expect(verifySignature(secret, sent[0]!.body, sent[0]!.headers["uhoney-signature"])).toBe(true);
    expect(matches("AssessmentUpdatedEvent", JSON.parse(sent[0]!.body))).toBe(true);
  });

  it("integration status reports every check", async () => {
    const r = await server(A, "GET", "/v1/integration/status");
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(matches("IntegrationStatus", s)).toBe(true);
    const byId = Object.fromEntries(s.checks.map((c: any) => [c.id, c.status]));
    expect(byId).toMatchObject({ key_valid: "pass", tag_seen: "pass", token_issued: "pass", pay_event_seen: "pass", assess_called: "pass", assess_headers: "fail", webhook_delivered: "pass", domain_verified: "not_applicable" });
    expect(s.all_passed).toBe(false);
  });

  it("merchants never see each other's data", async () => {
    expect((await server(B, "GET", `/v1/assessments/${A.assessment}`)).statusCode).toBe(404);
    expect((await dash(B, "GET", "/m/api/visits")).json().visits).toEqual([]);
    expect((await dash(B, "GET", "/m/api/orders")).json().orders).toEqual([]);
    expect((await dash(B, "GET", `/m/api/orders/${A.assessment}`)).statusCode).toBe(404);
    const aVisit = (await dash(A, "GET", "/m/api/visits")).json().visits[0].visit_id;
    expect((await dash(B, "GET", `/m/api/visits/${aVisit}`)).statusCode).toBe(404);
    expect((await dash(B, "POST", "/m/api/feedback", {})).statusCode).toBe(404);
    expect((await server(B, "POST", "/v1/feedback", { assessment_id: A.assessment, outcome: "fraud" })).statusCode).toBe(404);
    // B's site key cannot write into A's session.
    const r = await collect(B, { kind: "page", session_token: A.token, pl: "pv_bbbbbbbbbbbb", path: "/" });
    expect(r.statusCode).toBe(200);
    const aSessions = await db.admin`SELECT DISTINCT session_id FROM merchant_events WHERE merchant_id = ${B.id}`;
    const aSession = await db.admin`SELECT DISTINCT session_id FROM merchant_events WHERE merchant_id = ${A.id} AND kind = 'page'`;
    expect(aSessions.map((x) => x.session_id)).not.toContain(aSession[0]!.session_id);
  });

  it("admins see all merchants and can filter to one; the internal API is hidden without its token", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/merchants" })).statusCode).toBe(404);
    const all = (await internal("GET", "/internal/visits")).json().visits;
    expect(new Set(all.map((v: any) => v.merchant_id))).toEqual(new Set([A.id, B.id].filter((id) => all.some((v: any) => v.merchant_id === id))));
    const onlyA = (await internal("GET", `/internal/visits?merchant_id=${A.id}`)).json().visits;
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((v: any) => v.merchant_id === A.id)).toBe(true);
    expect((await internal("GET", "/internal/visits?merchant_id=bad")).statusCode).toBe(404);
    const merchants = (await internal("GET", "/internal/merchants")).json().merchants;
    expect(merchants.map((m: any) => m.merchant_id).sort()).toEqual([A.id, B.id].sort());
  });

  it("roles: an analyst can read but not change keys", async () => {
    const inv = await dash(A, "POST", "/m/api/team/invites", { email: "analyst@alpha.test", role: "analyst" });
    expect(inv.statusCode).toBe(201);
    const token = inv.json().invite_url.split("/m/invite/")[1];
    const acc = await app.inject({ method: "POST", url: `/m/api/invites/${token}/accept`, payload: { name: "Ana", password: "another long password", accept_terms: true } });
    const analyst = { cookie: cookieHeader(acc), csrf: acc.json().csrf };
    expect((await dash(analyst, "GET", "/m/api/visits")).statusCode).toBe(200);
    expect((await dash(analyst, "POST", "/m/api/keys", { kind: "secret", mode: "test" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/m/api/keys", payload: { kind: "secret", mode: "test" }, headers: { cookie: analyst.cookie } })).statusCode).toBe(403);
  });

  it("live keys need a verified domain; login works and logout ends the session", async () => {
    const live = await dash(A, "POST", "/m/api/keys", { kind: "secret", mode: "live" });
    expect(live.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/m/api/auth/login", payload: { email: "owner@alpha.test", password: "wrong password!!" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/m/api/auth/login", payload: { email: "OWNER@alpha.test", password: "correct horse battery" } });
    expect(ok.statusCode).toBe(200);
    const s = { cookie: cookieHeader(ok), csrf: ok.json().csrf };
    expect((await dash(s, "GET", "/m/api/auth/me")).json().merchant.id).toBe(A.id);
    await dash(s, "POST", "/m/api/auth/logout");
    expect((await dash(s, "GET", "/m/api/auth/me")).statusCode).toBe(401);
  });

  it("the documented Node helper works against the real API", async () => {
    process.env.UHONEY_SECRET_KEY = A.sk;
    process.env.UHONEY_API_URL = "https://api.example.test";
    const helper: any = await import("../../../docs/integrate/snippets/node/uhoney.mjs");
    const viaInject = async (url: string, init: any) => {
      const r = await app.inject({ method: init.method, url: new URL(url).pathname, payload: init.body, headers: init.headers });
      return new Response(r.body, { status: r.statusCode, headers: { "content-type": "application/json" } });
    };
    const a = await helper.assessOrder({ sessionToken: A.token, order: { id: "ord_helper", amount: 2500, currency: "eur" }, ip: "203.0.113.8", headers: { "user-agent": CHROME, accept: "text/html", "accept-language": "en", "sec-fetch-site": "same-origin", cookie: "x=1" }, method: "POST", path: "/checkout", host: "localhost:3000", fetchImpl: viaInject });
    expect(matches("Assessment", a)).toBe(true);
    expect(a.order).toEqual({ id: "ord_helper", amount: 2500, currency: "EUR" });
    const status = (await server(A, "GET", "/v1/integration/status")).json();
    expect(status.checks.find((c: any) => c.id === "assess_headers").status).toBe("pass");
  });

  it("suspending a merchant revokes its keys and sessions", async () => {
    expect((await internal("POST", `/internal/merchants/${B.id}/status`, { status: "suspended" })).statusCode).toBe(200);
    expect((await server(B, "GET", "/v1/integration/status")).json().error.code).toBe("key_revoked");
    expect((await dash(B, "GET", "/m/api/auth/me")).statusCode).toBe(401);
  });

  it("records who opened the public merchant pages, visible to admins only", async () => {
    await app.inject({ method: "GET", url: "/merchants", headers: { "user-agent": CHROME, referer: "https://wa.me/" }, remoteAddress: "198.51.100.23" });
    await app.inject({ method: "GET", url: "/integrate/v1/agent.md", headers: { "user-agent": "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)" }, remoteAddress: "198.51.100.24" });
    await app.inject({ method: "GET", url: "/v1/tag.js" });
    await new Promise((r) => setTimeout(r, 200));
    const r = await internal("GET", "/internal/page-hits?days=1");
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.hits.map((h: any) => h.path).sort()).toEqual(["/integrate/v1/agent.md", "/merchants"]);
    const guide = d.hits.find((h: any) => h.path === "/merchants");
    expect(guide).toMatchObject({ ip: "198.51.100.23", agent: null, referrer: "https://wa.me/" });
    expect(d.hits.find((h: any) => h.path === "/integrate/v1/agent.md").agent).toBe("chatgpt-user");
    expect(d.agents.map((a: any) => a.agent)).toContain("chatgpt-user");
    await expect(db.app`SELECT * FROM public_page_hits`).rejects.toThrow(/permission denied/);
    expect((await app.inject({ method: "GET", url: "/internal/page-hits" })).statusCode).toBe(404);
  });

  it("lab links on merchant sites: labelled visits for admins, hidden from merchants", async () => {
    const lab = signLabToken("claude-chrome-uchoco-1", Math.floor(Date.now() / 1000) + 3600, LAB_SECRET);
    const p = await collect(A, { kind: "page", pl: "pv_labrun00001", path: "/products/9", lab });
    const st = p.json().session_token;
    await collect(A, { kind: "behavior", session_token: st, pl: "pv_labrun00001", path: "/products/9", lab, data: { clicks: [] } });
    const a = await server(A, "POST", "/v1/assess", { session_token: st, order: { id: "ord_lab_1", amount: 990, currency: "EUR" }, request: { ip: "203.0.113.50", user_agent: CHROME, headers: { accept: "*/*", "accept-language": "en", "sec-fetch-site": "same-origin" } } });
    expect(a.statusCode).toBe(200);
    const [ev] = await db.admin`SELECT lab_label, lab_verified FROM merchant_events WHERE kind = 'assess' AND data->'order'->>'id' = 'ord_lab_1'`;
    expect(ev).toMatchObject({ lab_label: "claude-chrome-uchoco-1", lab_verified: true });
    await runScoringTick(db.admin, new Date(Date.now() - 3600_000));
    const runs = (await internal("GET", "/internal/lab-visits?labels=claude-chrome-uchoco-1,other")).json().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ label: "claude-chrome-uchoco-1", visits: 1, sites: ["alpha"] });
    const adminVisits = (await internal("GET", `/internal/visits?merchant_id=${A.id}&lab=1`)).json().visits;
    expect(adminVisits.map((v: any) => v.lab_label)).toEqual(["claude-chrome-uchoco-1"]);
    const merchantVisits = (await dash(A, "GET", "/m/api/visits")).json().visits;
    expect(merchantVisits.every((v: any) => !("lab_label" in v))).toBe(true);
    // A forged token counts as claimed, never verified.
    const fr = await collect(A, { kind: "page", pl: "pv_labrun00002", path: "/", lab: "claude-chrome-uchoco-1~9999999999~forgedforgedforgedforg" });
    expect(fr.statusCode, fr.body).toBe(200);
    const [forged] = await db.admin`SELECT lab_verified FROM merchant_events WHERE page_view_id = 'pv_labrun00002'`;
    expect(forged!.lab_verified).toBe(false);
  });

  it("visit detail: full for admins, plain findings for merchants", async () => {
    const id = (await dash(A, "GET", "/m/api/visits")).json().visits.find((v: any) => v.page_count >= 3).visit_id;
    const admin = (await internal("GET", `/internal/visits/${id}?merchant_id=${A.id}`)).json();
    const mine = (await dash(A, "GET", `/m/api/visits/${id}`)).json();
    for (const d of [admin, mine]) {
      expect(d.id).toBe(id);
      expect(d.score.control.pages.length).toBeGreaterThan(0);
      expect(Array.isArray(d.score.checks)).toBe(true);
      expect(d.merchant.timeline.length).toBeGreaterThan(3);
      expect(d.merchant.assessments.length).toBeGreaterThan(0);
    }
    expect(admin.network.ip).toBe("127.0.0.1");
    expect(admin.requests.length).toBeGreaterThan(0);
    expect(mine.network.ip).toBeNull();
    expect(mine.requests).toEqual([]);
    expect(mine.lab).toBeNull();
    expect(mine.score.reasons.every((r: any) => [-1, 0, 1].includes(r.weight))).toBe(true);
    expect(mine.fingerprint === null || !("globalsDiff" in mine.fingerprint)).toBe(true);
    // B is suspended by now (401); either way it never gets A's visit.
    expect([401, 404]).toContain((await dash(B, "GET", `/m/api/visits/${id}`)).statusCode);
  });

  it("serves the tag", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/tag.js" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("javascript");
    expect((await app.inject({ method: "GET", url: "/v1/tag.js", headers: { "if-none-match": r.headers.etag as string } })).statusCode).toBe(304);
  });
});
