import { useEffect, useState } from "react";
import { api, type GeographyResponse } from "../api.js";
import { BarList } from "../components/BarList.js";

const RANGES = ["1h", "24h", "7d"];

export function GeographyPage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState<GeographyResponse | null>(null);

  useEffect(() => {
    api.geography(range).then(setData).catch(console.error);
  }, [range]);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Geography</h1>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {data && !data.enrichmentActive && (
        <div className="banner warn">
          No enrichment data yet. GeoIP/ASN lookups are opt-in (<code>GEOLOCATION_ENABLED=true</code> +
          an <code>IPINFO_TOKEN</code>) and only apply to actors seen after enrichment was enabled — see docs/ROADMAP.md Phase 2.
        </div>
      )}

      {data && data.enrichmentActive && (
        <div className="grid-2">
          <div className="panel">
            <h2>Requests by country</h2>
            <BarList items={data.byCountry.map((c) => ({ label: `${c.country} (${c.actorCount} actors, avg risk ${c.avgRisk})`, count: c.requestCount }))} />
          </div>
          <div className="panel">
            <h2>Requests by ASN / organization</h2>
            <BarList items={data.byAsn.map((a) => ({ label: `${a.asn} ${a.organization ?? ""} (avg risk ${a.avgRisk})`, count: a.requestCount }))} />
          </div>
        </div>
      )}
    </div>
  );
}
