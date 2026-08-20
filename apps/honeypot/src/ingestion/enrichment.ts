import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { noopEnrichmentProvider, createIpinfoProvider, emptyEnrichment, type EnrichmentProvider } from "@honeypot/detection";
import { db } from "../db.js";
import { config } from "../config.js";

const provider: EnrichmentProvider = config.geolocationEnabled && process.env.IPINFO_TOKEN ? createIpinfoProvider(process.env.IPINFO_TOKEN) : noopEnrichmentProvider;

// Enrich each actor at most once per process lifetime — respects the provider's rate limit and
// avoids a DB write on every single request from an already-enriched actor. Acceptable
// simplification for Phase 2: an actor whose IP genuinely changes mid-session keeps its first
// lookup's geo data until the process restarts, rather than continuously re-resolving.
const enrichedActors = new Set<string>();

export async function enrichActorIfNeeded(rawIp: string, actorId: string): Promise<void> {
  if (provider === noopEnrichmentProvider) return;
  if (enrichedActors.has(actorId)) return;
  enrichedActors.add(actorId); // mark first, so concurrent requests for the same actor don't double-fire

  const enrichment = (await provider.lookup(rawIp).catch(() => null)) ?? emptyEnrichment();
  await db
    .update(schema.actors)
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
    .where(eq(schema.actors.actorId, actorId));
}
