/**
 * Which page-load ids we served to whom, so a beacon can be checked against the page it claims
 * (SDK_V2_IMPLEMENTATION_PLAN.md F5/I2). applyLadder() records every minted id with the actor and
 * session it was served to; rum.ts and the ladder routes then ask whether a beacon's id belongs to
 * the visitor sending it. Unbound beacons are stored but never count as evidence.
 *
 * In memory first (beacons arrive within seconds of the page), then request_signals.page_load_id
 * for ids minted before a restart or evicted from the cache (the lookup is installed by index.ts
 * via setPageLoadLookup, so this module stays free of DB imports for unit tests).
 */

export type PageLoadLookup = (pl: string) => Promise<{ actorId: string; sessionId: string | null } | null>;
let lookup: PageLoadLookup | null = null;
export function setPageLoadLookup(fn: PageLoadLookup | null) {
  lookup = fn;
}

const MAX_ENTRIES = 100_000;
const TTL_MS = 6 * 3600_000;

interface Served { actorId: string; sessionId: string; at: number }
const served = new Map<string, Served>();

export function recordServedPageLoad(pl: string, actorId: string, sessionId: string, now: number = Date.now()) {
  if (!pl || !actorId) return;
  served.delete(pl);
  served.set(pl, { actorId, sessionId, at: now });
  if (served.size > MAX_ENTRIES) {
    // Map keeps insertion order: drop the oldest entries.
    const excess = served.size - MAX_ENTRIES;
    let i = 0;
    for (const k of served.keys()) {
      if (i++ >= excess) break;
      served.delete(k);
    }
  }
}

const matches = (s: { actorId: string; sessionId: string | null }, actorId: string, sessionId: string) =>
  s.actorId === actorId || (!!sessionId && s.sessionId === sessionId);

/**
 * true: the id was served to this actor/session. false: no page load id, or it was served to
 * someone else / never served.
 */
export async function isBoundPageLoad(pl: string | null, actorId: string, sessionId: string, now: number = Date.now()): Promise<boolean> {
  if (!pl) return false;
  const hit = served.get(pl);
  if (hit && now - hit.at <= TTL_MS) return matches(hit, actorId, sessionId);
  if (!lookup) return false;
  try {
    const row = await lookup(pl);
    return row ? matches(row, actorId, sessionId) : false;
  } catch {
    return false;
  }
}

/** For tests. */
export function _resetServedPageLoads() {
  served.clear();
}
