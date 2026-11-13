import { describe, it, expect } from "vitest";
import { scoreVisit, latestPerPage, type RequestEvidence, type VisitEvidence } from "../src/agentScore.js";
import { consistencyChecks, environmentFacts, inputFacts, osFromPlatform, osFromUserAgent } from "../src/pageConsistency.js";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const req = (over: Partial<RequestEvidence> = {}): RequestEvidence => ({
  at: "2026-11-13T10:00:00Z", method: "GET", path: "/", status: 200, verdict: "browser", agent: null, verdictMethod: null,
  verdictReasons: [], uaLibrary: null, aiApp: null, browserFamily: "chrome", consistencyFlags: [], tor: false,
  isHtmlPage: true, isAsset: false, probing: false, userAgent: MAC_UA, acceptLanguage: "nl-NL,nl;q=0.9,en;q=0.8", ...over,
});
const fp = (over: Record<string, any> = {}) => ({
  nav: { webdriver: false, ua: MAC_UA, platform: "MacIntel", languages: ["nl-NL", "nl", "en"], hardwareConcurrency: 8, deviceMemory: 8, plugins: ["PDF Viewer"] },
  automation: { globals: [], webdriverGetterNative: true, cdpRuntime: false },
  webgl: { supported: true, renderer: "ANGLE (Apple, Apple M1)" }, canvas: "abc", screen: { w: 1512, h: 982, outerW: 1512, outerH: 900 },
  intl: { tz: "Europe/Amsterdam" }, uaData: { low: { platform: "macOS" } }, voices: 180, devices: { audioinput: 1, audiooutput: 2, videoinput: 1 },
  doc: { visibility: "visible", hasFocus: true }, ...over,
});
const visit = (over: Partial<VisitEvidence> = {}): VisitEvidence => ({
  requests: [req()], client: { fingerprints: [fp()], behaviors: [] }, asn: "AS1136", organization: "KPN B.V.", country: "NL", shopEvents: [], ...over,
});
const signals = (v: VisitEvidence) => scoreVisit(v).reasons.map((r) => r.signal);

describe("page consistency checks", () => {
  it("maps user-agents and platforms to an OS", () => {
    expect([osFromUserAgent(MAC_UA), osFromUserAgent(WIN_UA), osFromUserAgent(ANDROID_UA)]).toEqual(["mac", "windows", "android"]);
    expect([osFromPlatform("MacIntel"), osFromPlatform("Win32"), osFromPlatform("Linux x86_64"), osFromPlatform("Linux armv8l")]).toEqual(["mac", "windows", "linux", "linux"]);
  });

  it("finds a consistent human Mac in Amsterdam all-match", () => {
    const checks = consistencyChecks({ fingerprints: [fp()], headerUserAgents: [MAC_UA], acceptLanguages: ["nl-NL,nl;q=0.9"], ipCountry: "NL", viaProxy: false });
    expect(checks.map((c) => c.status)).toEqual(["match", "match", "match", "match", "match"]);
    expect(signals(visit())).not.toEqual(expect.arrayContaining(["ua_mismatch", "os_mismatch", "language_mismatch", "timezone_mismatch"]));
  });

  it("flags a Windows user-agent on a Linux machine (cloud browser disguise)", () => {
    const v = visit({ requests: [req({ userAgent: WIN_UA })], client: { fingerprints: [fp({ nav: { ...fp().nav, ua: WIN_UA, platform: "Linux x86_64" }, uaData: { low: { platform: "Linux" } } })], behaviors: [] } });
    expect(signals(v)).toContain("os_mismatch");
    expect(signals(v)).not.toContain("client_hints_mismatch"); // reported once, as os_mismatch
  });

  it("treats Android's Linux platform as consistent", () => {
    const v = visit({ requests: [req({ userAgent: ANDROID_UA })], client: { fingerprints: [fp({ nav: { ...fp().nav, ua: ANDROID_UA, platform: "Linux armv8l" }, uaData: { low: { platform: "Android" } } })], behaviors: [] } });
    expect(signals(v)).not.toContain("os_mismatch");
  });

  it("flags a rewritten header user-agent and a language patched in one place", () => {
    const v = visit({ requests: [req({ userAgent: WIN_UA, acceptLanguage: "en-US,en;q=0.9" })] });
    expect(signals(v)).toEqual(expect.arrayContaining(["ua_mismatch", "language_mismatch"]));
  });

  it("compares timezone with IP country, but not through a VPN/proxy or for unknown zones", () => {
    expect(signals(visit({ country: "US" }))).toContain("timezone_mismatch");
    expect(signals(visit({ country: "US", organization: "Cloudflare, Inc.", asn: "AS13335" }))).not.toContain("timezone_mismatch");
    expect(signals(visit({ country: "US", client: { fingerprints: [fp({ intl: { tz: "Antarctica/Troll" } })], behaviors: [] } }))).not.toContain("timezone_mismatch");
  });

  it("flags a UTC clock on desktop only", () => {
    expect(signals(visit({ client: { fingerprints: [fp({ intl: { tz: "UTC" } })], behaviors: [] } }))).toContain("utc_timezone");
    const mobile = fp({ intl: { tz: "UTC" }, nav: { ...fp().nav, ua: ANDROID_UA, platform: "Linux armv8l" } });
    expect(signals(visit({ requests: [req({ userAgent: ANDROID_UA })], client: { fingerprints: [mobile], behaviors: [] } }))).not.toContain("utc_timezone");
  });

  it("uses every page load, not just the first", () => {
    const v = visit({ client: { fingerprints: [fp(), fp({ nav: { ...fp().nav, webdriver: true } })], behaviors: [] } });
    expect(signals(v)).toContain("webdriver");
  });

  it("flags a fingerprint that changes within one visit", () => {
    const v = visit({ client: { fingerprints: [fp(), fp({ canvas: "zzz", webgl: { supported: true, renderer: "ANGLE (Intel)" } })], behaviors: [] } });
    expect(signals(v)).toContain("fingerprint_changed");
    expect(signals(visit({ client: { fingerprints: [fp(), fp()], behaviors: [] } }))).not.toContain("fingerprint_changed");
  });

  it("needs two virtual-machine tells together", () => {
    expect(environmentFacts([fp({ voices: 0 })]).tells).toHaveLength(1);
    expect(signals(visit({ client: { fingerprints: [fp({ voices: 0 })], behaviors: [] } }))).not.toContain("vm_environment");
    const vm = fp({ voices: 0, devices: {}, nav: { ...fp().nav, hardwareConcurrency: 2 } });
    expect(signals(visit({ client: { fingerprints: [vm], behaviors: [] } }))).toContain("vm_environment");
  });
});

describe("input facts", () => {
  const click = (t: number, dx: number, dy: number) => ({ t, x: 100 + t, y: 200, trusted: true, dx, dy, movesLast1s: 10, hadMouseDown: true });
  const beh = (clicks: any[], extra: Record<string, any> = {}, pl = "p1", clientT = 1) => ({ pl, clientT, path: "/", behavior: { mouseMoves: 80, mouseDistance: 3000, clicks, keyDowns: 0, inputWithoutKey: 0, scrolls: 3, ...extra } });

  it("keeps only the latest snapshot per page load", () => {
    const bs = latestPerPage([beh([], { mouseMoves: 10 }, "p1", 1), beh([], { mouseMoves: 50 }, "p1", 2), beh([], { mouseMoves: 5 }, "p2", 1)]);
    expect(bs.map((b) => b.behavior.mouseMoves).sort()).toEqual([5, 50]);
  });

  it("flags clicks that always land dead centre", () => {
    const b = beh([click(1, 0, 0), click(2, 0.01, -0.02), click(3, 0, 0.01), click(4, -0.01, 0)]);
    expect(inputFacts([b])).toMatchObject({ trustedClicks: 4, centredClicks: 4 });
    expect(signals(visit({ client: { fingerprints: [fp()], behaviors: [b] } }))).toContain("centred_clicks");
  });

  it("credits naturally spread clicks as human", () => {
    const b = beh([click(1, 0.3, -0.2), click(2, -0.25, 0.1), click(3, 0.05, 0.35), click(4, -0.4, -0.1)]);
    expect(signals(visit({ client: { fingerprints: [fp()], behaviors: [b] } }))).toContain("human_click_spread");
  });

  it("reads typing corrections and paste-only input", () => {
    const typedClean = beh([], { keyDowns: 30, keyKinds: { printable: 30, nav: 0, modifier: 0, enter: 0, other: 0 } });
    expect(signals(visit({ client: { fingerprints: [fp()], behaviors: [typedClean] } }))).toContain("no_typing_corrections");
    const typedFixed = beh([], { keyDowns: 20, keyKinds: { printable: 16, nav: 3, modifier: 1, enter: 0, other: 0 } });
    expect(signals(visit({ client: { fingerprints: [fp()], behaviors: [typedFixed] } }))).toContain("typing_corrections");
    const pasted = beh([], { pastes: 3, keyDowns: 0 });
    expect(signals(visit({ client: { fingerprints: [fp()], behaviors: [pasted] } }))).toContain("paste_only_input");
  });
});
