import type { EnrichmentProvider, IpEnrichment } from "../enrichment.js";

/**
 * ipinfo.io provider — chosen over MaxMind GeoLite2 for Phase 2 because it's a plain HTTP API
 * call with a token (no local .mmdb database file to download, license, and periodically
 * refresh). Free tier: 50k lookups/month, which is why callers must cache aggressively (see
 * apps/honeypot/src/ingestion/enrichment.ts — enriches once per actor, not per request).
 *
 * Requires the operator's own ipinfo.io account/token — account creation is on them, same as
 * every other external service this project touches (AWS, Render). Never required: the app
 * runs fully functional with GEOLOCATION_ENABLED=false (default) or no token set.
 */
export function createIpinfoProvider(token: string): EnrichmentProvider {
  return {
    name: "ipinfo",
    async lookup(ip: string): Promise<IpEnrichment | null> {
      let res: Response;
      try {
        res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`, {
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        return null; // network failure/timeout — enrichment is best-effort, never fatal
      }
      if (!res.ok) return null;

      let body: Record<string, unknown>;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        return null;
      }

      // ipinfo's "org" field is formatted "AS15169 Google LLC" — split ASN from org name.
      const org = typeof body.org === "string" ? body.org : null;
      const orgMatch = org?.match(/^AS(\d+)\s+(.*)$/);

      return {
        country: typeof body.country === "string" ? body.country : null,
        region: typeof body.region === "string" ? body.region : null,
        city: typeof body.city === "string" ? body.city : null,
        asn: orgMatch ? `AS${orgMatch[1]}` : null,
        organization: orgMatch ? orgMatch[2]! : org,
        // Hosting-provider detection is a paid ipinfo feature (their "privacy" field) — not
        // available on the free tier this provider targets. See docs/ARCHITECTURE.md §5 on
        // distinguishing observed fact from inference; leaving this null is more honest than
        // guessing from the org name.
        isHostingProvider: null,
      };
    },
  };
}
