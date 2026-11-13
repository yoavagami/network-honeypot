import { describe, it, expect } from "vitest";
import { isJumpClick, pageControl } from "../src/pageControl.js";
import { latestPerPage, scoreVisit, type RequestEvidence, type VisitEvidence } from "../src/agentScore.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const jump = (t: number) => ({ t, x: 400, y: 300, trusted: true, detail: 1, pointer: "mouse", movesLast1s: 1, msSinceMove: 6, hadMouseDown: true, dx: 0, dy: 0 });
const aimed = (t: number) => ({ t, x: 410, y: 320, trusted: true, detail: 1, pointer: "mouse", movesLast1s: 18, msSinceMove: 120, hadMouseDown: true, dx: 0.2, dy: -0.15 });
const page = (pl: string, at: string, path: string, behavior: Record<string, any>) => ({ pl, at, clientT: 5000, path, behavior: { mouseMoves: 0, mouseDistance: 0, clicks: [], keyDowns: 0, pastes: 0, wheels: 0, touches: 0, scrolls: 0, inputWithoutKey: 0, ...behavior } });

// The real claude-full-buy-3-11-11 run, reduced: Claude drives cart → checkout → shipping, a person takes over at payment.
const agentCart = page("p1", "2026-11-11T22:19:53Z", "/cart", { mouseMoves: 1, clicks: [jump(11490)], scrolls: 9 });
const agentCheckout = page("p2", "2026-11-11T22:20:13Z", "/checkout", { mouseMoves: 1, clicks: [jump(23307)], scrolls: 86, inputs: { none: 7 } });
const agentShipping = page("p3", "2026-11-11T22:20:27Z", "/checkout/shipping", { mouseMoves: 1, clicks: [jump(5491)] });
const humanPayment = page("p4", "2026-11-11T22:20:42Z", "/checkout/payment", { mouseMoves: 51, mouseDistance: 2031, wheels: 43, scrolls: 37, clicks: [aimed(54578)] });
const humanCart = page("p5", "2026-11-11T22:21:23Z", "/cart", { mouseMoves: 20, mouseDistance: 399, clicks: [aimed(974)] });

const req = (over: Partial<RequestEvidence> = {}): RequestEvidence => ({
  at: "2026-11-11T22:19:40Z", method: "GET", path: "/", status: 200, verdict: "browser", agent: null, verdictMethod: null, verdictReasons: [], uaLibrary: null,
  aiApp: null, browserFamily: "chrome", consistencyFlags: [], tor: false, isHtmlPage: true, isAsset: false, probing: false, userAgent: UA, acceptLanguage: "en-US", ...over,
});
const visit = (behaviors: any[]): VisitEvidence => ({
  requests: [req(), req({ path: "/cart" }), req({ path: "/checkout" })], asn: "AS1136", organization: "KPN B.V.", country: "NL", shopEvents: [],
  client: { fingerprints: [{ nav: { webdriver: false, ua: UA, platform: "MacIntel", languages: ["en-US"] }, automation: { globals: [] }, webgl: { supported: true, renderer: "ANGLE (Apple)" }, intl: { tz: "Europe/Amsterdam" }, doc: { visibility: "visible", hasFocus: true }, globalsDiff: ["0", "1", "2", "3", "Stripe"] }], behaviors },
});

describe("jump clicks", () => {
  it("needs ≤1 move and ≤50 ms since it, and skips keyboard, touch and synthetic clicks", () => {
    expect(isJumpClick(jump(1))).toBe(true);
    expect(isJumpClick(aimed(1))).toBe(false);
    expect(isJumpClick({ ...jump(1), msSinceMove: 4000 })).toBe(false); // resting cursor, then click
    expect(isJumpClick({ ...jump(1), detail: 0 })).toBe(false); // Enter/Space on a button
    expect(isJumpClick({ ...jump(1), zeroCoords: true })).toBe(false);
    expect(isJumpClick({ ...jump(1), pointer: "touch" })).toBe(false);
    expect(isJumpClick({ ...jump(1), trusted: false })).toBe(false);
  });
});

describe("page control", () => {
  it("labels each page and finds the agent → human handover", () => {
    const c = pageControl([agentCart, agentCheckout, agentShipping, humanPayment, humanCart]);
    expect(c.pages.map((p) => p.driver)).toEqual(["agent", "agent", "agent", "human", "human"]);
    expect(c).toMatchObject({ mode: "agent_then_human", agentDriven: true, jumpClicks: 3, scriptFilledFields: 7, inputlessScrollPages: 2 });
    expect(c.handover).toMatchObject({ path: "/checkout/payment", from: "agent", to: "human" });
  });

  it("finds human → agent, all-agent and all-human visits", () => {
    const earlyHuman = { ...humanCart, pl: "p0", at: "2026-11-11T22:18:00Z" };
    expect(pageControl([earlyHuman, agentCheckout, agentShipping]).mode).toBe("human_then_agent");
    expect(pageControl([agentCart, agentCheckout]).mode).toBe("agent");
    expect(pageControl([humanPayment, humanCart]).mode).toBe("human");
    const lateAgent = { ...agentShipping, pl: "p8", at: "2026-11-11T22:25:00Z" };
    expect(pageControl([agentCart, humanPayment, lateAgent]).mode).toBe("mixed");
  });

  it("needs more than one stray jump click to call a visit agent-driven", () => {
    const c = pageControl([agentShipping, humanPayment, humanCart]);
    expect(c.agentDriven).toBe(false);
    expect(c.mode).toBe("human");
  });

  it("doesn't call a form filled by typing or pasting script-filled", () => {
    const typed = page("t", "2026-11-11T10:00:00Z", "/checkout", { inputs: { insertText: 40 }, keyDowns: 40 });
    const pasted = page("u", "2026-11-11T10:00:00Z", "/checkout", { inputs: { none: 3, insertFromPaste: 2 }, pastes: 2 });
    expect(pageControl([typed]).scriptFilledFields).toBe(0);
    expect(pageControl([pasted]).scriptFilledFields).toBe(0);
  });

  it("dates pages by their first report, not a back/forward-cache page clock", () => {
    const restored = { ...humanCart, pl: "p9", at: "2026-11-11T22:23:38Z", clientT: 537026 };
    const bs = latestPerPage([agentCheckout, { ...restored, at: "2026-11-11T22:21:42Z", clientT: 1000 }, restored]);
    const c = pageControl(bs);
    expect(c.pages.map((p) => p.path)).toEqual(["/checkout", "/cart"]);
    expect(c.pages[1]!.at).toBe("2026-11-11T22:21:42.000Z");
  });
});

describe("score with hybrid control", () => {
  it("scores the Claude run as an agent despite the person's mouse at payment", () => {
    const s = scoreVisit(visit([agentCart, agentCheckout, agentShipping, humanPayment, humanCart]));
    const sig = (id: string) => s.reasons.find((r) => r.signal === id);
    expect(s.bucket).toBe("ai_agent");
    expect(s.type).toBe("in_browser_agent");
    expect(s.control.mode).toBe("agent_then_human");
    expect(sig("jump_clicks")?.weight).toBe(2);
    expect(sig("form_set_by_script")?.weight).toBe(1.8);
    expect(sig("scroll_without_input")?.weight).toBe(0.8);
    expect(sig("handover_agent_to_human")?.text).toMatch(/\/checkout\/payment/);
    expect(sig("cursor_teleport")).toBeUndefined(); // replaced by jump_clicks, not double-counted
  });

  it("ignores iframe indexes (window[0]…) as injected globals", () => {
    const s = scoreVisit(visit([humanPayment]));
    expect(s.reasons.find((r) => r.signal === "injected_globals")).toBeUndefined();
  });

  it("leaves a plain human visit's human credit intact", () => {
    const s = scoreVisit(visit([humanPayment, humanCart]));
    expect(s.control.mode).toBe("human");
    expect(s.reasons.find((r) => r.signal === "human_mouse")?.weight).toBeLessThan(0);
    expect(s.bucket).toBe("not_ai_agent");
  });
});

// SDK 1.2.1 splits untyped input events: browser autofill fires trusted ones, a script's
// dispatchEvent(new Event("input")) untrusted ones. Shaped like the human-chrome-Nov13-17 run.
describe("browser autofill vs script-filled forms", () => {
  const autofillCheckout = page("a1", "2026-11-13T16:06:00Z", "/checkout", {
    mouseMoves: 120, mouseDistance: 2400, wheels: 6, clicks: [aimed(3000)],
    inputs: { none: 7 }, untypedTrusted: 7, untypedUntrusted: 0, autofilled: 7,
  });
  const scriptCheckout = page("s1", "2026-11-13T16:06:00Z", "/checkout", {
    mouseMoves: 1, clicks: [jump(3000)], inputs: { none: 7 }, untypedTrusted: 0, untypedUntrusted: 7, autofilled: 0,
  });

  it("counts trusted untyped inputs as autofill, not a script", () => {
    const c = pageControl([autofillCheckout]);
    expect(c.scriptFilledFields).toBe(0);
    expect(c.autofilledFields).toBe(7);
    expect(c.pages[0]!.driver).toBe("human");
    expect(c.agentDriven).toBe(false);
  });

  it("still calls untrusted untyped inputs script-filled", () => {
    const c = pageControl([scriptCheckout]);
    expect(c.scriptFilledFields).toBe(7);
    expect(c.autofilledFields).toBe(0);
    expect(c.agentDriven).toBe(true);
  });

  it("keeps the old rule for snapshots from before SDK 1.2.1", () => {
    expect(pageControl([agentCheckout]).scriptFilledFields).toBe(7);
  });

  it("scores a fast autofilled checkout as a person", () => {
    const v = { ...visit([autofillCheckout]), shopEvents: ["SHOP_ORDER_PLACED"] };
    const s = scoreVisit(v);
    const ids = s.reasons.map((r) => r.signal);
    expect(ids).toContain("browser_autofill");
    expect(ids).not.toContain("form_set_by_script");
    expect(ids).not.toContain("instant_checkout");
    expect(s.bucket).toBe("not_ai_agent");
    const scripted = scoreVisit({ ...visit([scriptCheckout]), shopEvents: ["SHOP_ORDER_PLACED"] });
    expect(scripted.reasons.map((r) => r.signal)).toContain("form_set_by_script");
    expect(scripted.reasons.map((r) => r.signal)).toContain("instant_checkout");
  });
});
