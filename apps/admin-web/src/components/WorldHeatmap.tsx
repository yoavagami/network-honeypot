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
}

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

export function WorldHeatmap({ points }: { points: HeatmapPoint[] }) {
  const countryPaths = useMemo(() => {
    const topology = countriesTopology as unknown as Topology;
    const collection = feature(topology, topology.objects.countries as GeometryCollection) as unknown as {
      features: Feature[];
    };
    return collection.features.map((f) => ({ id: f.id, d: geometryToPath(f.geometry) }));
  }, []);

  const maxCount = Math.max(1, ...points.map((p) => p.requestCount));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="heatmap-svg" role="img" aria-label="Request origins, world map">
      <defs>
        <radialGradient id="heatGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--heat-core)" stopOpacity="0.95" />
          <stop offset="45%" stopColor="var(--heat-mid)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--heat-edge)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="var(--heatmap-ocean)" />

      {countryPaths.map((c) => (
        <path key={String(c.id)} d={c.d} fill="var(--heatmap-land)" stroke="var(--heatmap-border)" strokeWidth="0.5" />
      ))}

      {points.map((p, i) => {
        const [x, y] = project(p.lng, p.lat);
        const r = pointRadius(p.requestCount, maxCount);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={r * 2.2} fill="url(#heatGlow)" />
            <circle cx={x} cy={y} r={Math.max(2, r * 0.28)} fill="var(--heat-core)">
              <title>
                {[p.city, p.country].filter(Boolean).join(", ") || "Unknown location"} — {p.requestCount} request{p.requestCount === 1 ? "" : "s"}, max risk {p.maxRisk}
              </title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}
