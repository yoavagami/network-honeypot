import { and, eq, or, sql } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { noopEnrichmentProvider, createIpinfoProvider, emptyEnrichment, type EnrichmentProvider, type IpEnrichment } from "@honeypot/detection";
import { db } from "../db.js";
import { config } from "../config.js";

const provider: EnrichmentProvider = config.geolocationEnabled && process.env.IPINFO_TOKEN ? createIpinfoProvider(process.env.IPINFO_TOKEN) : noopEnrichmentProvider;

/** The coarse network a request came from, stored on its request_signals row (data.network). */
export interface RequestNetwork {
  asn: string | null;
  organization: string | null;
  country: string | null;
  city: string | null;
}

// One lookup per IP per process, shared by the actor update and every request from that IP. Bounded:
// the oldest entries are dropped first (Map keeps insertion order).
const MAX_CACHED_IPS = 20_000;
const byIp = new Map<string, Promise<IpEnrichment | null>>();
// Which IP each actor was last enriched from. An actor is re-enriched when its IP changes, so a
// visitor who moves network (home → VPN → mobile) gets the new network, not the first one seen.
const actorIp = new Map<string, string>();

function lookup(rawIp: string, ipHash: string): Promise<IpEnrichment | null> {
  const hit = byIp.get(ipHash);
  if (hit) return hit;
  const p = provider.lookup(rawIp).catch(() => null);
  byIp.set(ipHash, p);
  if (byIp.size > MAX_CACHED_IPS) byIp.delete(byIp.keys().next().value!);
  // A failed lookup is retried on the next request from that IP.
  void p.then((e) => { if (!e) byIp.delete(ipHash); });
  return p;
}

export async function enrichActorIfNeeded(rawIp: string, ipHash: string, actorId: string): Promise<void> {
  if (provider === noopEnrichmentProvider) return;
  if (actorIp.get(actorId) === ipHash) return;
  actorIp.set(actorId, ipHash); // mark first, so concurrent requests for the same actor don't double-fire
  if (actorIp.size > MAX_CACHED_IPS) actorIp.delete(actorIp.keys().next().value!);

  try {
    const enrichment = (await lookup(rawIp, ipHash)) ?? emptyEnrichment();
    const a = schema.actors;
    // Only written when the network actually changed, so enrichment_updated_at means "the network
    // last changed here" — loadVisitRows relies on that for requests stored before data.network.
    await db
      .update(a)
      .set({
        country: enrichment.country,
        region: enrichment.region,
        city: enrichment.city,
        asn: enrichment.asn,
        organization: enrichment.organization,
        lat: enrichment.lat,
        lng: enrichment.lng,
        enrichmentUpdatedAt: new Date(),
      })
      .where(and(eq(a.actorId, actorId), or(
        sql`${a.asn} IS DISTINCT FROM ${enrichment.asn}`,
        sql`${a.organization} IS DISTINCT FROM ${enrichment.organization}`,
        sql`${a.country} IS DISTINCT FROM ${enrichment.country}`,
        sql`${a.city} IS DISTINCT FROM ${enrichment.city}`,
      )));
  } catch (err) {
    // Found live: a failed write here (e.g. schema not yet migrated — actors.lat/lng didn't
    // exist yet on one deployment) previously left this actor permanently marked "enriched" for
    // the rest of the process's lifetime, since the mark above is set optimistically before the
    // write. Un-marking on failure lets the next request retry instead.
    actorIp.delete(actorId);
    throw err;
  }
}

/**
 * The network this request came from, for its request_signals row. Runs after the response has
 * gone out (capture.ts finalizeRequest), so waiting briefly for the shared lookup costs the visitor
 * nothing. null when enrichment is off, the lookup failed, or it took longer than `waitMs`.
 */
export async function requestNetwork(rawIp: string | null | undefined, ipHash: string | null | undefined, waitMs = 1500): Promise<RequestNetwork | null> {
  if (provider === noopEnrichmentProvider || !rawIp || !ipHash) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try {
    const e = await Promise.race([lookup(rawIp, ipHash), timeout]);
    return e ? { asn: e.asn, organization: e.organization, country: e.country, city: e.city } : null;
  } finally {
    clearTimeout(timer);
  }
}
