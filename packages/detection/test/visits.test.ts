import { describe, it, expect } from "vitest";
import { buildVisits, visitEvidence, visitSummary, type VisitClientRow, type VisitRequestRow } from "../src/visits.js";
import { scoreVisit } from "../src/agentScore.js";

const A = "11111111-1111-1111-1111-111111111111";
const S1 = "22222222-2222-2222-2222-222222222222";
const T0 = Date.parse("2026-11-13T10:00:00Z");
let n = 0;
const req = (over: Partial<VisitRequestRow> & { at: number }): VisitRequestRow => ({
  request_id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, created_at: new Date(over.at), actor_id: A, session_id: S1,
  method: "GET", path: "/", query_string: null, status_code: 200, user_agent_raw: "Mozilla/5.0 Chrome/131", ip: "198.51.100.7",
  lab_label: null, lab_verified: false, identity_verdict: "browser", identity_agent: null, ua_library: null, ja4: null, h2_fp: null,
  wba_status: "absent", wba_signer: null, ip_tor: false, verdict_method: null, verdict_reasons: [], ai_app: null, browser_family: "chrome",
  flags: [], asn: "AS1136", organization: "KPN B.V.", country: "NL", city: null, accept_language: "en-US", page_load_id: null, ...over,
});
const beacon = (over: Partial<VisitClientRow> & { at: number }): VisitClientRow => ({
  session_id: S1, actor_id: A, kind: "behavior", created_at: new Date(over.at), path: "/", lab_label: null, lab_verified: false,
  page_load_id: null, bound: true, data: {}, ...over,
});

describe("visits", () => {
  it("splits one session at a 30-minute gap and when the lab label changes", () => {
    const rows = [
      req({ at: T0 }), req({ at: T0 + 60_000 }),
      req({ at: T0 + 45 * 60_000 }), // after a 44-minute gap
      req({ at: T0 + 46 * 60_000, lab_label: "claude-chrome-shop-1", lab_verified: true }), // agent run starts
    ];
    const vs = buildVisits(rows, [], []);
    expect(vs.map((v) => v.requests.length)).toEqual([2, 1, 1]);
    expect(vs[0]!.id).toBe(`s_${S1}_${T0}`);
  });

  it("folds cookieless one-request sessions of one actor into a burst visit", () => {
    const rows = [0, 1, 2].map((i) => req({ at: T0 + i * 1000, session_id: `33333333-3333-3333-3333-33333333333${i}` }));
    const vs = buildVisits(rows, [], []);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.id).toBe(`a_${A}_${T0}`);
    expect(vs[0]!.sessionId).toBeNull();
  });

  it("attaches beacons to the segment that was open when they arrived", () => {
    const rows = [req({ at: T0 }), req({ at: T0 + 45 * 60_000 })];
    const vs = buildVisits(rows, [beacon({ at: T0 + 2000 }), beacon({ at: T0 + 46 * 60_000 })], []);
    expect(vs.map((v) => v.client.length)).toEqual([1, 1]);
  });

  it("leaves unbound beacons out of the evidence and flags them", () => {
    const humanBehavior = { visibility: "visible", focus: true, behavior: { mouseMoves: 300, mouseDistance: 12_000, wheels: 9, clicks: [] } };
    const rows = [req({ at: T0, page_load_id: "plplplplplplplplplplpl" })];
    const [v] = buildVisits(rows, [beacon({ at: T0 + 2000, bound: false, page_load_id: "forgedforgedforgedforged", data: humanBehavior })], []);
    const ev = visitEvidence(v!, new Date(T0 + 60_000));
    expect(ev.client.behaviors).toHaveLength(0);
    expect(ev.client.unboundBeacons).toBe(1);
    const s = scoreVisit(ev);
    const signals = s.reasons.map((r) => r.signal);
    expect(signals).toContain("beacon_unbound");
    expect(signals).not.toContain("human_mouse");
  });

  it("still uses beacons from before binding existed (bound = null)", () => {
    const rows = [req({ at: T0 })];
    const [v] = buildVisits(rows, [beacon({ at: T0 + 2000, bound: null, data: { behavior: { mouseMoves: 300, mouseDistance: 12_000, wheels: 9 } } })], []);
    expect(visitEvidence(v!).client.behaviors).toHaveLength(1);
  });

  it("calls a visit's lab label verified only if every labeled row was signed", () => {
    const signed = buildVisits([req({ at: T0, lab_label: "human-chrome-1", lab_verified: true }), req({ at: T0 + 1000, lab_label: "human-chrome-1", lab_verified: true })], [], [])[0]!;
    const mixed = buildVisits([req({ at: T0, lab_label: "human-chrome-2", lab_verified: true }), req({ at: T0 + 1000, lab_label: "human-chrome-2", lab_verified: false })], [], [])[0]!;
    expect(visitSummary(signed, scoreVisit(visitEvidence(signed))).labVerified).toBe(true);
    expect(visitSummary(mixed, scoreVisit(visitEvidence(mixed))).labVerified).toBe(false);
  });
});
