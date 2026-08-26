/**
 * Classifies an actor's network origin from its GeoIP-enriched ASN/organization (see
 * providers/ipinfo.ts) — "is this AWS, a VPS provider, a residential ISP, a known scanner?"
 * Purely a read-time computation over data already captured; no new enrichment calls, no new
 * DB columns. See docs/DATA_MODEL.md and the Geography page's infra-origin breakdown.
 *
 * Two layers, ranked by reliability — this is a best-effort classification, not a certainty
 * claim, the same way actor confidence elsewhere in this app is explicit about "signal
 * agreement, not certainty of identity":
 *   1. Exact ASN match ("known") — a curated table of real, documented ASNs.
 *   2. Organization-name substring match ("heuristic") — fallback when the ASN isn't in the
 *      table but the org name is still recognizable.
 * Deliberately not exhaustive — starts narrow, easy to extend once real data shows what's
 * actually landing in "unclassified".
 */

export type InfraCategory = "cloud_aws" | "cloud_azure" | "cloud_gcp" | "cloud_other" | "hosting_vps" | "known_scanner" | "residential_mobile" | "unclassified" | "unknown";

export interface InfraClassification {
  category: InfraCategory;
  confidence: "known" | "heuristic" | "none";
  label: string;
}

const ASN_TABLE: Record<string, InfraCategory> = {
  // Cloud
  AS16509: "cloud_aws",
  AS14618: "cloud_aws",
  AS8075: "cloud_azure",
  AS15169: "cloud_gcp",
  AS396982: "cloud_gcp",
  AS31898: "cloud_other", // Oracle Cloud
  AS45102: "cloud_other", // Alibaba Cloud
  AS37963: "cloud_other", // Alibaba Cloud
  // Hosting / VPS
  AS14061: "hosting_vps", // DigitalOcean
  AS24940: "hosting_vps", // Hetzner
  AS16276: "hosting_vps", // OVH
  AS63949: "hosting_vps", // Linode/Akamai
  AS20473: "hosting_vps", // Vultr (AS-CHOOPA)
  AS51167: "hosting_vps", // Contabo
  // Known scanners / security vendors
  AS398722: "known_scanner", // Censys
};

const ORG_SUBSTRING_TABLE: Array<{ pattern: RegExp; category: InfraCategory }> = [
  { pattern: /amazon/i, category: "cloud_aws" },
  { pattern: /microsoft/i, category: "cloud_azure" },
  { pattern: /google/i, category: "cloud_gcp" },
  { pattern: /oracle/i, category: "cloud_other" },
  { pattern: /alibaba/i, category: "cloud_other" },
  { pattern: /digitalocean/i, category: "hosting_vps" },
  { pattern: /hetzner/i, category: "hosting_vps" },
  { pattern: /\bovh\b/i, category: "hosting_vps" },
  { pattern: /linode/i, category: "hosting_vps" },
  { pattern: /vultr|choopa/i, category: "hosting_vps" },
  { pattern: /contabo/i, category: "hosting_vps" },
  { pattern: /censys/i, category: "known_scanner" },
  { pattern: /shodan/i, category: "known_scanner" },
  { pattern: /rapid7/i, category: "known_scanner" },
  { pattern: /palo alto networks/i, category: "known_scanner" },
  { pattern: /netcraft/i, category: "known_scanner" },
  { pattern: /criminalip/i, category: "known_scanner" },
  { pattern: /leakix/i, category: "known_scanner" },
  { pattern: /comcast/i, category: "residential_mobile" },
  { pattern: /verizon/i, category: "residential_mobile" },
  { pattern: /at&t|att corp/i, category: "residential_mobile" },
  { pattern: /t-mobile/i, category: "residential_mobile" },
  { pattern: /vodafone/i, category: "residential_mobile" },
  { pattern: /deutsche telekom/i, category: "residential_mobile" },
  { pattern: /orange s\.?a\.?/i, category: "residential_mobile" },
  { pattern: /telefonica/i, category: "residential_mobile" },
  { pattern: /charter communications/i, category: "residential_mobile" },
  { pattern: /cox communications/i, category: "residential_mobile" },
  { pattern: /british telecom|\bbt group\b/i, category: "residential_mobile" },
  { pattern: /china telecom|china unicom|china mobile/i, category: "residential_mobile" },
];

const CATEGORY_LABELS: Record<InfraCategory, string> = {
  cloud_aws: "Cloud — AWS",
  cloud_azure: "Cloud — Azure",
  cloud_gcp: "Cloud — GCP",
  cloud_other: "Cloud — Other",
  hosting_vps: "Hosting / VPS",
  known_scanner: "Known Scanner / Security Vendor",
  residential_mobile: "Residential / Mobile ISP",
  unclassified: "Unclassified",
  unknown: "No Enrichment Data",
};

export function classifyOrigin(asn: string | null, organization: string | null): InfraClassification {
  if (!asn && !organization) return { category: "unknown", confidence: "none", label: CATEGORY_LABELS.unknown };

  if (asn && ASN_TABLE[asn]) {
    const category = ASN_TABLE[asn]!;
    return { category, confidence: "known", label: CATEGORY_LABELS[category] };
  }

  if (organization) {
    const match = ORG_SUBSTRING_TABLE.find((entry) => entry.pattern.test(organization));
    if (match) return { category: match.category, confidence: "heuristic", label: CATEGORY_LABELS[match.category] };
  }

  return { category: "unclassified", confidence: "none", label: CATEGORY_LABELS.unclassified };
}

export const INFRA_CATEGORY_LABELS = CATEGORY_LABELS;
