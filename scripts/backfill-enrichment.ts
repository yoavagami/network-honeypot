import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@honeypot/db";
import { createIpinfoProvider, emptyEnrichment } from "@honeypot/detection";

/**
 * One-off backfill for actors recorded before GEOLOCATION_ENABLED/IPINFO_TOKEN were set — normal
 * enrichment (apps/honeypot/src/ingestion/enrichment.ts) only fires on new requests, so it never
 * reaches actors who won't visit again. Picks each actor's most recent still-retained ip_raw and
 * runs it through the same provider/update path.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const token = process.env.IPINFO_TOKEN;
if (!token) throw new Error("IPINFO_TOKEN is required");

const requiresSsl = process.env.DATABASE_SSL === "true" || connectionString.includes("sslmode=require");
const client = postgres(connectionString, { max: 1, ssl: requiresSsl ? "require" : undefined });
const db = drizzle(client, { schema });
const provider = createIpinfoProvider(token);

async function main() {
  const actors = await db.select({ actorId: schema.actors.actorId }).from(schema.actors).where(isNull(schema.actors.country));
  console.log(`${actors.length} actor(s) missing geo data`);

  let enriched = 0;
  let skipped = 0;
  for (const { actorId } of actors) {
    const [latest] = await db
      .select({ ipRaw: schema.requests.ipRaw })
      .from(schema.requests)
      .where(and(eq(schema.requests.actorId, actorId), isNotNull(schema.requests.ipRaw)))
      .orderBy(desc(schema.requests.createdAt))
      .limit(1);

    if (!latest?.ipRaw) {
      skipped++;
      continue;
    }

    const enrichment = (await provider.lookup(latest.ipRaw).catch(() => null)) ?? emptyEnrichment();
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
    enriched++;
  }

  console.log(`enriched ${enriched}, skipped ${skipped} (raw IP already redacted — past RAW_IP_RETENTION_DAYS)`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
