import { describe, it, expect } from "vitest";
import { renderingLadder, rungFor, LADDER_GRACE_MS } from "../src/renderingLadder.js";
import { scoreVisit, type RequestEvidence, type VisitEvidence } from "../src/agentScore.js";

const T = Date.parse("2026-11-13T10:00:00Z");
const at = (ms: number) => new Date(T + ms).toISOString();
const page = (pl: string, ms = 0, path = "/") => ({ pl, path, at: at(ms) });
const hit = (pl: string, rung: "css" | "noscript" | "js", ms = 500) => ({ pl, rung, at: at(ms) });
const later = T + LADDER_GRACE_MS + 1;

describe("rendering ladder", () => {
  it("places each combination on the right rung", () => {
    const settled = { settled: true };
    expect(rungFor({ css: false, noscript: false, js: false, ...settled })).toBe("html_only");
    expect(rungFor({ css: false, noscript: true, js: false, ...settled })).toBe("images_only");
    expect(rungFor({ css: true, noscript: true, js: false, ...settled })).toBe("css_no_js");
    expect(rungFor({ css: true, noscript: false, js: true, ...settled })).toBe("ran_js");
    expect(rungFor({ css: false, noscript: false, js: true, ...settled })).toBe("js_no_css");
  });

  it("waits out the grace period before calling a page HTML-only", () => {
    expect(renderingLadder([page("a")], [], T + 5_000)).toMatchObject({ summary: "pending", pages: [{ rung: "pending", settled: false }] });
    expect(renderingLadder([page("a")], [], later).summary).toBe("html_only");
  });

  it("settles a page as soon as a later page is fetched", () => {
    const l = renderingLadder([page("a", 0), page("b", 2_000)], [hit("a", "css")], T + 3_000);
    expect(l.pages.map((p) => p.rung)).toEqual(["css_no_js", "pending"]);
  });

  it("does not wait for CSS when JS already reported", () => {
    expect(renderingLadder([page("a")], [hit("a", "js")], T + 1_000).pages[0]!.rung).toBe("ran_js");
  });

  it("summarises the visit by its highest settled rung and ignores hits for unknown pages", () => {
    const l = renderingLadder([page("a", 0), page("b", 1_000)], [hit("a", "css"), hit("b", "js"), hit("b", "css"), hit("zzz", "js")], later);
    expect(l.summary).toBe("ran_js");
    expect(l.pages).toHaveLength(2);
  });
});

const req = (over: Partial<RequestEvidence> = {}): RequestEvidence => ({
  at: at(0), method: "GET", path: "/", status: 200, verdict: "browser", agent: null, verdictMethod: null,
  verdictReasons: [], uaLibrary: null, aiApp: null, browserFamily: "chrome", consistencyFlags: [], tor: false,
  isHtmlPage: true, isAsset: false, probing: false, ...over,
});
const visit = (hits: ReturnType<typeof hit>[], over: Partial<VisitEvidence> = {}): VisitEvidence => ({
  requests: [req()], client: { fingerprints: [], behaviors: [] }, asn: "AS1136", organization: "KPN B.V.", shopEvents: [],
  ladder: { served: [page("a")], hits }, evaluatedAt: new Date(later).toISOString(), ...over,
});
const signals = (v: VisitEvidence) => scoreVisit(v).reasons.map((r) => r.signal);

describe("ladder in the agent score", () => {
  it("flags an HTML-only fetch from a single page, instead of the two-page fallback", () => {
    const s = scoreVisit(visit([]));
    expect(s.reasons.map((r) => r.signal)).toContain("html_only");
    expect(s.reasons.map((r) => r.signal)).not.toContain("no_subresources");
    expect(s.reasons.find((r) => r.signal === "html_only")!.weight).toBe(1.6); // browser UA, yet no rendering
    expect(s.type).toBe("script");
    expect(s.ladder.summary).toBe("html_only");
  });

  it("stays capped at 'not sure' without AI-specific evidence", () => {
    expect(scoreVisit(visit([])).probability).toBeLessThanOrEqual(0.69);
  });

  it("recognises an HTML parser that fetches images", () => {
    expect(signals(visit([hit("a", "noscript")]))).toContain("html_parser_images");
  });

  it("recognises CSS rendering with JavaScript switched off", () => {
    const s = scoreVisit(visit([hit("a", "css"), hit("a", "noscript")]));
    expect(s.reasons.find((r) => r.signal === "css_no_js")?.text).toMatch(/switched off/);
  });

  it("flags JavaScript without CSS (DOM emulator / image-blocking automation)", () => {
    expect(signals(visit([hit("a", "js")]))).toContain("js_without_css");
  });

  it("adds nothing for a normal browser", () => {
    const sig = signals(visit([hit("a", "css"), hit("a", "js")]));
    expect(sig.filter((x) => ["html_only", "html_parser_images", "css_no_js", "js_without_css", "no_javascript", "no_subresources"].includes(x))).toEqual([]);
  });

  it("adds nothing while the only page is still pending", () => {
    const sig = signals(visit([], { evaluatedAt: at(1_000) }));
    expect(sig).not.toContain("html_only");
  });
});
