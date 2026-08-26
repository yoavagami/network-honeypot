import { useMemo } from "react";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry, Position } from "geojson";
import countriesTopology from "../assets/countries-110m.json";

export interface HeatmapPoint {
  lat: number;
  lng: number;
  country: string | null;
  city: string | null;
  requestCount: number;
  maxRisk: number;
  infra: { category: string; confidence: "known" | "heuristic" | "none"; label: string };
}

// Flat categorical palette, deliberately consistent across light/dark theme (unlike the
// single-hue risk gradient below) — these are meant to be identifiable "the AWS one" /
// "the scanner one" regardless of viewer theme, the way a legend key should behave.
const CATEGORY_COLORS: Record<string, string> = {
  cloud_aws: "#f5a623",
  cloud_azure: "#0078d4",
  cloud_gcp: "#34a853",
  cloud_other: "#8e44ad",
  hosting_vps: "#17a2b8",
  known_scanner: "#e91e63",
  residential_mobile: "#6c757d",
  unclassified: "#adb5bd",
  unknown: "#495057",
};

const WIDTH = 800;
const HEIGHT = 400;

// Plain equirectangular projection — deliberately not a real map library (no new heavyweight
// geo-projection dependency for one dashboard panel). lon/lat -> x/y is just linear scaling.
// Trade-off: a handful of countries whose raw coordinates cross the antimeridian (Russia, Fiji,
// the Aleutians) render with a stray horizontal seam rather than being properly split — a known
// cosmetic limitation of this simplification, not a bug in the projection math.
function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * WIDTH;
  const y = ((90 - lat) / 180) * HEIGHT;
  return [x, y];
}

function ringToPath(ring: Position[]): string {
  return ring.map((pos, i) => {
    const [x, y] = project(pos[0]!, pos[1]!);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ") + "Z";
}

function geometryToPath(geometry: Geometry): string {
  if (geometry.type === "Polygon") return geometry.coordinates.map(ringToPath).join(" ");
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly: Position[][]) => poly.map(ringToPath).join(" ")).join(" ");
  return "";
}

// Log scale for both radius and glow spread — a single busy scanner shouldn't visually erase
// every other point on the map the way a linear scale would once one location has 10x the volume
// of the rest (a very real shape for honeypot traffic: a handful of aggressive scanners plus a
// long tail of one-off probes).
function pointRadius(requestCount: number, maxCount: number): number {
  const minR = 4;
  const maxR = 22;
  if (maxCount <= 1) return minR;
  const t = Math.log(requestCount + 1) / Math.log(maxCount + 1);
  return minR + t * (maxR - minR);
}

const CATEGORY_LEGEND_ORDER = ["cloud_aws", "cloud_azure", "cloud_gcp", "cloud_other", "hosting_vps", "known_scanner", "residential_mobile", "unclassified", "unknown"];
const CATEGORY_LEGEND_LABELS: Record<string, string> = {
  cloud_aws: "AWS",
  cloud_azure: "Azure",
  cloud_gcp: "GCP",
  cloud_other: "Other cloud",
  hosting_vps: "Hosting / VPS",
  known_scanner: "Known scanner",
  residential_mobile: "Residential / mobile",
  unclassified: "Unclassified",
  unknown: "No enrichment",
};

export function WorldHeatmap({ points, colorBy }: { points: HeatmapPoint[]; colorBy: "risk" | "infra" }) {
  const countryPaths = useMemo(() => {
    const topology = countriesTopology as unknown as Topology;
    const collection = feature(topology, topology.objects.countries as GeometryCollection) as unknown as {
      features: Feature[];
    };
    return collection.features.map((f) => ({ id: f.id, d: geometryToPath(f.geometry) }));
  }, []);

  const maxCount = Math.max(1, ...points.map((p) => p.requestCount));
  const categoriesPresent = colorBy === "infra" ? [...new Set(points.map((p) => p.infra.category))] : [];

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="heatmap-svg" role="img" aria-label="Request origins, world map">
        <defs>
          <radialGradient id="heatGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--heat-core)" stopOpacity="0.95" />
            <stop offset="45%" stopColor="var(--heat-mid)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--heat-edge)" stopOpacity="0" />
          </radialGradient>
          {CATEGORY_LEGEND_ORDER.map((cat) => (
            <radialGradient key={cat} id={`heatGlow-${cat}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={CATEGORY_COLORS[cat]} stopOpacity="0.95" />
              <stop offset="45%" stopColor={CATEGORY_COLORS[cat]} stopOpacity="0.5" />
              <stop offset="100%" stopColor={CATEGORY_COLORS[cat]} stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>

        <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="var(--heatmap-ocean)" />

        {countryPaths.map((c) => (
          <path key={String(c.id)} d={c.d} fill="var(--heatmap-land)" stroke="var(--heatmap-border)" strokeWidth="0.5" />
        ))}

        {points.map((p, i) => {
          const [x, y] = project(p.lng, p.lat);
          const r = pointRadius(p.requestCount, maxCount);
          const coreColor = colorBy === "infra" ? CATEGORY_COLORS[p.infra.category] : "var(--heat-core)";
          const glowUrl = colorBy === "infra" ? `url(#heatGlow-${p.infra.category})` : "url(#heatGlow)";
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={r * 2.2} fill={glowUrl} />
              <circle cx={x} cy={y} r={Math.max(2, r * 0.28)} fill={coreColor}>
                <title>
                  {[p.city, p.country].filter(Boolean).join(", ") || "Unknown location"} — {p.requestCount} request{p.requestCount === 1 ? "" : "s"}, max risk {p.maxRisk}
                  {colorBy === "infra" ? ` — ${p.infra.label}${p.infra.confidence === "heuristic" ? " (best guess)" : ""}` : ""}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>

      {colorBy === "infra" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: ".75rem", marginTop: ".5rem" }}>
          {CATEGORY_LEGEND_ORDER.filter((cat) => categoriesPresent.includes(cat)).map((cat) => (
            <span key={cat} style={{ display: "inline-flex", alignItems: "center", gap: ".35rem", fontSize: ".78rem" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", background: CATEGORY_COLORS[cat], display: "inline-block" }} />
              {CATEGORY_LEGEND_LABELS[cat]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
