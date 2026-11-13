import { describe, it, expect } from "vitest";
import { buildVisits, scoreVisit, visitEvidence, SCORER_VERSION, type VisitRequestRow } from "@honeypot/detection";
import { visitScoreRow } from "../src/scoring/rows.js";

const T0 = Date.parse("2026-11-13T10:00:00Z");
const req = (at: number, over: Partial<VisitRequestRow> = {}): VisitRequestRow => ({
  request_id: `00000000-0000-0000-0000-00000000000${at % 10}`, created_at: new Date(at), actor_id: "a", session_id: "s",
  method: "GET", path: "/", query_string: null, status_code: 200, user_agent_raw: "curl/8.4", ip: "203.0.113.5",
  lab_label: null, lab_verified: false, identity_verdict: "automation", identity_agent: "curl", ua_library: "curl", ja4: "t13d", h2_fp: null,
  wba_status: "absent", wba_signer: null, ip_tor: false, verdict_method: "user_agent", verdict_reasons: ["user-agent is the curl HTTP client"],
  ai_app: null, browser_family: null, flags: [], asn: null, organization: null, country: null, city: null, accept_language: null, page_load_id: null, ...over,
});

describe("visit_scores rows", () => {
  it("stores the verdict, signals and summary of a scored visit", () => {
    const [v] = buildVisits([req(T0), req(T0 + 1000)], [], []);
    const now = new Date(T0 + 5 * 60_000);
    const row = visitScoreRow(v!, scoreVisit(visitEvidence(v!, now)), now);
    expect(row).toMatchObject({ visit_id: `s_s_${T0}`, scorer_version: SCORER_VERSION, settled: false, request_count: 2, type: "script", ip: "203.0.113.5" });
    expect(row.signals).toContain("automation_client");
    expect(row.summary.ja4).toBe("t13d");
  });

  it("marks a visit settled once it has been quiet for the visit gap", () => {
    const [v] = buildVisits([req(T0)], [], []);
    const later = new Date(T0 + 31 * 60_000);
    expect(visitScoreRow(v!, scoreVisit(visitEvidence(v!, later)), later).settled).toBe(true);
  });
});
