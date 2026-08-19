/**
 * IP enrichment interface — see docs/PRIVACY.md (`GEOLOCATION_ENABLED`) and docs/ROADMAP.md
 * Phase 2. Enrichment is async and cached by design: it must never sit on the request path, and
 * a slow/unreachable provider must never break ingestion. Phase 1 ships only the no-op
 * provider below; a real provider (MaxMind GeoLite2, ipinfo.io) is a one-file addition that
 * implements this same interface.
 */
export interface IpEnrichment {
  country: string | null;
  region: string | null;
  city: string | null;
  asn: string | null;
  organization: string | null;
  isHostingProvider: boolean | null;
}

export interface EnrichmentProvider {
  readonly name: string;
  lookup(ip: string): Promise<IpEnrichment | null>;
}

/** Default Phase 1 provider — always returns nulls. Enrichment is opt-in and disabled by
 * default (`GEOLOCATION_ENABLED=false`); this keeps the app fully functional without it. */
export const noopEnrichmentProvider: EnrichmentProvider = {
  name: "noop",
  async lookup(): Promise<IpEnrichment | null> {
    return null;
  },
};

const EMPTY_ENRICHMENT: IpEnrichment = {
  country: null,
  region: null,
  city: null,
  asn: null,
  organization: null,
  isHostingProvider: null,
};

export function emptyEnrichment(): IpEnrichment {
  return { ...EMPTY_ENRICHMENT };
}
