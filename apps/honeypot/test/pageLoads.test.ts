import { describe, it, expect, beforeEach } from "vitest";
import { isBoundPageLoad, recordServedPageLoad, setPageLoadLookup, _resetServedPageLoads } from "../src/sensing/pageLoads.js";
import { carriesKnownArtifact } from "../src/routes/rum.js";

describe("beacon → served page binding", () => {
  beforeEach(() => { _resetServedPageLoads(); setPageLoadLookup(null); });

  it("binds a beacon to the page served to the same actor or session", async () => {
    recordServedPageLoad("pl-aaaaaaaaaaaaaaaaaaaa", "actor-1", "sess-1");
    expect(await isBoundPageLoad("pl-aaaaaaaaaaaaaaaaaaaa", "actor-1", "sess-1")).toBe(true);
    expect(await isBoundPageLoad("pl-aaaaaaaaaaaaaaaaaaaa", "actor-2", "sess-1")).toBe(true); // re-correlated actor, same session
    expect(await isBoundPageLoad("pl-aaaaaaaaaaaaaaaaaaaa", "actor-2", "sess-2")).toBe(false);
  });

  it("rejects missing and never-served ids", async () => {
    expect(await isBoundPageLoad(null, "actor-1", "sess-1")).toBe(false);
    expect(await isBoundPageLoad("made-up-id-xxxxxxxxxxxx", "actor-1", "sess-1")).toBe(false);
  });

  it("falls back to the DB lookup for ids not in memory (after a restart)", async () => {
    setPageLoadLookup(async (pl) => (pl === "pl-from-db-xxxxxxxxxxx" ? { actorId: "actor-9", sessionId: null } : null));
    expect(await isBoundPageLoad("pl-from-db-xxxxxxxxxxx", "actor-9", "sess-9")).toBe(true);
    expect(await isBoundPageLoad("pl-from-db-xxxxxxxxxxx", "actor-1", "sess-1")).toBe(false);
    setPageLoadLookup(async () => { throw new Error("db down"); });
    expect(await isBoundPageLoad("pl-other-xxxxxxxxxxxxx", "actor-1", "sess-1")).toBe(false);
  });

  it("raises beacons carrying a known agent's DOM marker", () => {
    expect(carriesKnownArtifact({ artifacts: [{ id: "claude-agent-stop-container", known: "claude-in-chrome" }] })).toBe(true);
    expect(carriesKnownArtifact({ artifacts: [{ id: "x", known: null }] })).toBe(false);
    expect(carriesKnownArtifact({})).toBe(false);
  });
});
