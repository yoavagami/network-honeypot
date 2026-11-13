import { describe, it, expect } from "vitest";
import { scoreVisit, bucketFor, type RequestEvidence, type VisitEvidence } from "../src/agentScore.js";

const req = (over: Partial<RequestEvidence> = {}): RequestEvidence => ({
  at: "2026-10-31T10:00:00Z", method: "GET", path: "/", status: 200, verdict: "browser", agent: null, verdictMethod: null,
  verdictReasons: [], uaLibrary: null, aiApp: null, browserFamily: "chrome", consistencyFlags: [], tor: false,
  isHtmlPage: true, isAsset: false, probing: false, ...over,
});
const visit = (over: Partial<VisitEvidence> = {}): VisitEvidence => ({
  requests: [req()], client: { fingerprints: [], behaviors: [] }, asn: "AS1136", organization: "KPN B.V.", shopEvents: [], ...over,
});
const humanFp = { nav: { webdriver: false }, automation: { globals: [], webdriverGetterNative: true, cdpRuntime: false }, webgl: { supported: true, renderer: "ANGLE (Apple M1)" }, screen: { outerW: 1512, outerH: 900 }, doc: { visibility: "visible", hasFocus: true } };

describe("agent score", () => {
  it("buckets by probability", () => {
    expect([bucketFor(0.95), bucketFor(0.8), bucketFor(0.5), bucketFor(0.1)]).toEqual(["ai_agent", "probably_ai_agent", "not_sure", "not_ai_agent"]);
  });

  it("proves a signed ChatGPT agent", () => {
    const s = scoreVisit(visit({ requests: [req({ verdict: "verified", agent: "chatgpt-agent", verdictReasons: ["Web Bot Auth signature verified for https://chatgpt.com"] })] }));
    expect(s).toMatchObject({ bucket: "ai_agent", type: "cloud_browser_agent", agent: "chatgpt-agent", proven: true });
  });

  it("keeps a verified search crawler out of the AI-agent bucket", () => {
    const s = scoreVisit(visit({ requests: [req({ verdict: "verified", agent: "googlebot", browserFamily: null })] }));
    expect(s).toMatchObject({ bucket: "not_ai_agent", type: "search_crawler", proven: true });
  });

  it("proves Comet from its DOM marker", () => {
    const s = scoreVisit(visit({ client: { fingerprints: [humanFp], behaviors: [{ artifacts: [{ known: "perplexity-comet", id: "pplx-agent-overlay-stop-button", tag: "DIV" }] }] } }));
    expect(s).toMatchObject({ bucket: "ai_agent", type: "in_browser_agent", agent: "perplexity-comet" });
  });

  it("scores the observed Claude-in-Chrome run as an in-browser AI agent", () => {
    const s = scoreVisit(visit({
      requests: [req(), req({ at: "2026-10-31T10:00:05Z", path: "/search" }), req({ path: "/assets/app.css", isHtmlPage: false, isAsset: true })],
      client: {
        fingerprints: [{ ...humanFp, screen: { outerW: 0, outerH: 0 }, doc: { visibility: "hidden", hasFocus: false } }],
        behaviors: [{ visibility: "hidden", focus: true, behavior: { mouseMoves: 2, mouseDistance: 163, clickCount: 1, clicks: [{ trusted: true, movesLast1s: 1, hadMouseDown: true }], keyDowns: 0, inputWithoutKey: 0, scrolls: 0 } }],
      },
    }));
    expect(s.type).toBe("in_browser_agent");
    expect(s.probability).toBeGreaterThan(0.85);
    expect(s.reasons.map((r) => r.signal)).toEqual(expect.arrayContaining(["driven_while_hidden", "cursor_teleport"]));
  });

  it("calls a person browsing normally not an AI agent", () => {
    const s = scoreVisit(visit({
      requests: [req(), req({ path: "/assets/shop.css", isHtmlPage: false, isAsset: true })],
      client: { fingerprints: [humanFp], behaviors: [{ visibility: "visible", focus: true, behavior: { mouseMoves: 220, mouseDistance: 9000, wheels: 12, clicks: [{ trusted: true, movesLast1s: 30, hadMouseDown: true }], keyIntervals: [80, 140, 95, 210, 60, 170, 120, 300, 90] } }] },
    }));
    expect(s.bucket).toBe("not_ai_agent");
    expect(s.type).toBe("human");
  });

  it("caps a scanner wearing AI user-agents (Oct 27 case) below the AI buckets", () => {
    const s = scoreVisit(visit({
      asn: "AS396982", organization: "Google LLC",
      requests: [
        req({ verdict: "spoofed", agent: "gptbot", verdictReasons: ["user-agent claims gptbot (OpenAI) but IP not in openai-gptbot.json"], browserFamily: null, probing: true, path: "/.env" }),
        req({ verdict: "claimed", agent: "bytespider", browserFamily: null, probing: true, path: "/.git/config" }),
      ],
    }));
    expect(s.type).toBe("scanner");
    expect(s.bucket).toBe("not_ai_agent");
  });

  it("is unsure about a plain curl fetch from home", () => {
    const s = scoreVisit(visit({ requests: [req({ verdict: "automation", agent: "curl", uaLibrary: "curl", browserFamily: null })] }));
    expect(s.bucket).toBe("not_sure");
    expect(s.type).toBe("script");
  });

  it("flags a data-centre headless browser with a software GPU as an AI agent candidate", () => {
    const s = scoreVisit(visit({
      asn: "AS16509", organization: "Amazon.com, Inc.",
      requests: [req({ consistencyFlags: ["chromium_ua_without_client_hints"] })],
      client: { fingerprints: [{ ...humanFp, nav: { webdriver: true }, webgl: { supported: true, renderer: "Google SwiftShader" } }], behaviors: [] },
    }));
    expect(s.probability).toBeGreaterThan(0.9);
    expect(s.type).toBe("cloud_browser_agent");
  });

  it("keeps a cloud script faking Chrome at 'not sure' — automated, but not shown to be AI (live Tencent case)", () => {
    const s = scoreVisit(visit({
      asn: "AS132203", organization: "Tencent Building, Kejizhongyi Avenue",
      requests: [req({ consistencyFlags: ["tls_not_chromium", "h2_pseudo_order_not_chromium", "chromium_ua_without_client_hints", "no_accept_language"] })],
    }));
    expect(s.bucket).toBe("not_sure");
    expect(s.type).toBe("script");
    expect(s.leaning).toBe("agent");
  });

  it("explains every point of the score", () => {
    const s = scoreVisit(visit({ requests: [req({ uaLibrary: "python-httpx", verdict: "automation", browserFamily: null })] }));
    expect(s.reasons.length).toBeGreaterThan(0);
    for (const r of s.reasons) expect(r.text.length).toBeGreaterThan(10);
    expect(s.calibrated).toBe(false);
  });

  it("doesn't count Stripe.js's own globals on the payment page as injected scripts", () => {
    const stripeFp = { ...humanFp, globalsDiff: ["0", "1", "2", "webpackChunkStripeJSouter", "noop", "Stripe", "__SJS_PERF_STATE__"] };
    const s = scoreVisit(visit({ client: { fingerprints: [stripeFp], behaviors: [] } }));
    expect(s.reasons.map((r) => r.signal)).not.toContain("injected_globals");
    // …but other injected names next to Stripe still count
    const agentFp = { ...humanFp, globalsDiff: ["Stripe", "noop", "__agentA", "__agentB", "__agentC", "__agentD"] };
    expect(scoreVisit(visit({ client: { fingerprints: [agentFp], behaviors: [] } })).reasons.map((r) => r.signal)).toContain("injected_globals");
    // and "noop" without Stripe is not exempt
    const noStripe = { ...humanFp, globalsDiff: ["noop", "__x1", "__x2", "__x3"] };
    expect(scoreVisit(visit({ client: { fingerprints: [noStripe], behaviors: [] } })).reasons.map((r) => r.signal)).toContain("injected_globals");
  });

  it("names an agent from a probe hit and treats it as proof", () => {
    const s = scoreVisit(visit({ client: { fingerprints: [humanFp], behaviors: [], probes: [{ hits: [{ method: "decoy_stack", agent: "browser-use", t: 2300 }], overlays: [] }] } }));
    expect(s).toMatchObject({ bucket: "ai_agent", agent: "browser-use", proven: true, type: "in_browser_agent" });
    expect(s.reasons[0]!.text).toContain("decoy field");
    const cloud = scoreVisit(visit({ asn: "AS16509", organization: "Amazon.com, Inc.", client: { fingerprints: [humanFp], behaviors: [], probes: [{ hits: [{ method: "message_handshake", agent: "manus" }] }] } }));
    expect(cloud).toMatchObject({ agent: "manus", type: "cloud_browser_agent", proven: true });
  });

  it("ignores probe summaries without hits", () => {
    const s = scoreVisit(visit({ client: { fingerprints: [humanFp], behaviors: [], probes: [{ hits: [], overlays: [{ tag: "DIV" }] }] } }));
    expect(s.proven).toBe(false);
  });

  it("flags an anonymous <body> overlay only when it shows up on most pages", () => {
    const overlay = { tag: "DIV", parent: "BODY", id: "", cls: "", attrs: [], text: 0 };
    const page = (path: string, withOverlay: boolean) => ({ path, pl: path, visibility: "visible", behavior: { mouseMoves: 0 }, foreign: { count: withOverlay ? 1 : 0, items: withOverlay ? [overlay] : [] } });
    const sig = (bs: any[]) => scoreVisit(visit({ client: { fingerprints: [humanFp], behaviors: bs } })).reasons.map((r) => r.signal);
    expect(sig(["/", "/cart", "/checkout"].map((p) => page(p, true)))).toContain("anonymous_body_overlay");
    expect(sig([page("/", true), page("/cart", true), page("/checkout", false), page("/about", false)])).not.toContain("anonymous_body_overlay");
    // Stripe adds its own anonymous divs on the payment page — never counted
    expect(sig([page("/checkout/payment", true), page("/checkout/payment?x", true), page("/", true)])).not.toContain("anonymous_body_overlay");
  });
});
