import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assessRequest } from "@honeypot/merchant-contract";
import { buildDocs } from "../src/docs/build.js";
import { toHtml } from "../src/docs/markdown.js";
import { signatureHeader } from "../src/webhooks/sign.js";

const GENERATED = (f: string) => readFileSync(fileURLToPath(new URL(`../generated/${f}`, import.meta.url)), "utf8");
const KNOWN = new Set(["API_URL", "TAG_URL", "DASHBOARD_URL", "DOCS_URL", "AGENT_URL", "TAG_BASE", "TAG_HOST", "API_HOST"]);

describe("integration docs", () => {
  const built = buildDocs();

  it("generated files are up to date (run pnpm --filter @honeypot/app-merchant-api build:docs)", () => {
    for (const [name, body] of Object.entries(built)) expect(GENERATED(name), name).toBe(body);
  });

  it("use only placeholders the server fills in", () => {
    for (const [name, body] of Object.entries(built)) {
      for (const m of body.matchAll(/\{\{([A-Za-z_:/.-]+)\}\}/g)) expect(KNOWN.has(m[1]!), `${name}: {{${m[1]}}}`).toBe(true);
    }
  });

  it("the developer page and the agent file contain the same steps and snippets", () => {
    const agent = built["agent.md"]!;
    for (const h of ["## 1. Before you start", "## 5. Call Assess on your server, before the charge", "## 7. Verify", "### Next.js (App Router)", "## Troubleshooting"]) {
      expect(agent).toContain(h);
      expect(built["developer.html"]).toContain(h.replace(/^#+ /, "").replace(/&/g, "&amp;"));
    }
    expect(agent).toContain("export async function assessOrder");
    expect(built["developer.html"]).toContain("export async function assessOrder");
  });

  it("the agent file states the hard rules", () => {
    const agent = built["agent.md"]!;
    for (const rule of ["Secret key on the server only", "Fail open", "Never change payment behaviour", "Only add code", "Never forward `cookie` or `authorization`", "Test keys only", "UHONEY_INTEGRATION.md", "Without keys", "Never ask the developer to paste a secret key", "uhoney-integration", "Never merge it yourself"]) expect(agent).toContain(rule);
  });

  it("the developer page escapes code (no live script tags from the source)", () => {
    expect(built["developer.html"]!.match(/<script/g)).toBeNull();
    expect(built["developer.html"]).toContain("&lt;script async src=");
  });

  it("markdown renderer escapes HTML and renders nested lists", () => {
    const { html } = toHtml("1. **One** <b>x</b>\n   - nested `a<b`\n2. Two");
    expect(html).toBe("<ol><li><strong>One</strong> &lt;b&gt;x&lt;/b&gt;<ul><li>nested <code>a&lt;b</code></li></ul></li><li>Two</li></ol>");
  });
});

describe("Node helper snippet (docs/integrate/snippets/node/uhoney.mjs)", () => {
  let mod: any;
  const env = { ...process.env };
  beforeAll(async () => {
    process.env.UHONEY_SECRET_KEY = "sk_test_" + "a".repeat(32);
    process.env.UHONEY_WEBHOOK_SECRET = "whsec_" + "b".repeat(32);
    process.env.UHONEY_API_URL = "https://api.example.test";
    mod = await import("../../../docs/integrate/snippets/node/uhoney.mjs");
  });
  afterAll(() => { process.env = env; });

  const input = (fetchImpl: any) => ({
    sessionToken: "st_" + "x".repeat(20) + "." + "y".repeat(20),
    order: { id: "ord_1", amount: 12900, currency: "eur" },
    ip: "203.0.113.7",
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-GB", cookie: "sid=secret", authorization: "Basic x", "sec-fetch-site": "same-origin" },
    method: "POST", path: "/checkout", host: "shop.test",
    fetchImpl,
  });

  it("sends a contract-valid request with the secret key, idempotency key and only safe headers", async () => {
    let seen: any;
    const res = await mod.assessOrder(input(async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ assessment_id: "as_x", driver: "human", suggested_action: "allow" }), { status: 200 }); }));
    expect(res.assessment_id).toBe("as_x");
    expect(seen.url).toBe("https://api.example.test/v1/assess");
    expect(seen.init.headers.authorization).toBe(`Bearer ${process.env.UHONEY_SECRET_KEY}`);
    expect(seen.init.headers["idempotency-key"]).toBe("ord_1");
    const body = JSON.parse(seen.init.body);
    expect(assessRequest.safeParse(body).success).toBe(true);
    expect(body.order.currency).toBe("EUR");
    expect(body.request.headers).toEqual({ "accept-language": "en-GB", "sec-fetch-site": "same-origin" });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("works with Fetch API Headers (Next.js)", async () => {
    let body: any;
    await mod.assessOrder({ ...input(async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response("{}", { status: 200 }); }), headers: new Headers({ "user-agent": "UA", accept: "*/*", cookie: "x" }) });
    expect(body.request.user_agent).toBe("UA");
    expect(body.request.headers).toEqual({ accept: "*/*" });
  });

  it("fails open: timeout, server error, network error and missing key all return null", async () => {
    const hang = (_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const t0 = Date.now();
    expect(await mod.assessOrder({ ...input(hang), timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await mod.assessOrder(input(async () => new Response("oops", { status: 500 })))).toBeNull();
    expect(await mod.assessOrder(input(async () => { throw new Error("ECONNREFUSED"); }))).toBeNull();
    expect(await mod.assessOrder(input(async () => new Response("not json", { status: 200 })))).toBeNull();
    const k = process.env.UHONEY_SECRET_KEY;
    delete process.env.UHONEY_SECRET_KEY;
    expect(await mod.assessOrder(input(async () => { throw new Error("must not be called"); }))).toBeNull();
    process.env.UHONEY_SECRET_KEY = k;
  });

  it("drops a value that isn't a session token", async () => {
    let body: any;
    await mod.assessOrder({ ...input(async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response("{}"); }), sessionToken: "<script>" });
    expect(body.session_token).toBeUndefined();
  });

  it("verifies webhooks signed by the server, and rejects tampering and old signatures", () => {
    const raw = '{"id":"evt_1","type":"assessment.updated"}';
    const secret = process.env.UHONEY_WEBHOOK_SECRET!;
    expect(mod.verifyWebhook(raw, signatureHeader(secret, raw))).toBe(true);
    expect(mod.verifyWebhook(raw + " ", signatureHeader(secret, raw))).toBe(false);
    expect(mod.verifyWebhook(raw, signatureHeader(secret, raw, Math.floor(Date.now() / 1000) - 600))).toBe(false);
    expect(mod.verifyWebhook(raw, signatureHeader("whsec_other", raw))).toBe(false);
    expect(mod.verifyWebhook(raw, undefined)).toBe(false);
  });

  it("maps a verdict to order fields and Stripe metadata (strings only)", () => {
    const a = { assessment_id: "as_1", driver: "agent", suggested_action: "review", agent: { id: "browser-use", verified: false }, score: 0.93 };
    expect(mod.verdictFields(a)).toEqual({ uhoney_assessment_id: "as_1", uhoney_driver: "agent", uhoney_action: "review" });
    const md = mod.stripeMetadata(a);
    expect(Object.values(md).every((v) => typeof v === "string")).toBe(true);
    expect(md).toMatchObject({ uhoney_agent: "browser-use", uhoney_agent_verified: "false", uhoney_score: "0.93" });
    expect(mod.stripeMetadata(null)).toEqual({});
  });
});
