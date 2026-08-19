import { useEffect, useState } from "react";
import { api, type DiscoveryFunnelResponse, type IngestionHealth, type OverviewResponse } from "../api.js";
import { StatCard } from "../components/StatCard.js";
import { BarList } from "../components/BarList.js";
import { Funnel } from "../components/Funnel.js";

const RANGES = ["5m", "1h", "24h", "7d"];

export function OverviewPage() {
  const [range, setRange] = useState("24h");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [funnel, setFunnel] = useState<DiscoveryFunnelResponse | null>(null);
  const [ingestion, setIngestion] = useState<IngestionHealth | null>(null);
  const [ingestionError, setIngestionError] = useState(false);

  useEffect(() => {
    api.overview(range).then(setOverview).catch(console.error);
    api.discoveryFunnel(range).then(setFunnel).catch(console.error);
  }, [range]);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      api
        .ingestion()
        .then((h) => !cancelled && (setIngestion(h), setIngestionError(false)))
        .catch(() => !cancelled && setIngestionError(true));
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ marginRight: "auto" }}>Overview</h1>
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {ingestionError && <div className="banner error">Ingestion metrics unreachable — the honeypot app may be down or unreachable from admin-api.</div>}
      {ingestion && ingestion.events_dropped_total > 0 && (
        <div className="banner warn">
          {ingestion.events_dropped_total} events dropped under backpressure since startup (queue depth {ingestion.queue_depth}/{ingestion.queue_capacity}).
        </div>
      )}
      {ingestion && ingestion.events_dropped_total === 0 && !ingestionError && (
        <div className="banner ok">
          Ingestion healthy — {ingestion.events_processed_total} events processed, 0 dropped. Last flush{" "}
          {ingestion.last_successful_flush_at ? new Date(ingestion.last_successful_flush_at).toLocaleTimeString() : "never"}.
        </div>
      )}

      {overview && (
        <>
          <div className="stat-grid">
            <StatCard label="Requests" value={overview.totals.totalRequests} />
            <StatCard label="Unique actors" value={overview.totals.uniqueActors} />
            <StatCard label="Unique IPs" value={overview.totals.uniqueIps} />
            <StatCard label="Unique user agents" value={overview.totals.uniqueUserAgents} />
            <StatCard label="Errors (4xx/5xx)" value={overview.totals.errorCount} />
            <StatCard label="Detections" value={overview.detectionCount} />
            <StatCard label="Canary triggers" value={overview.canaryTriggerCount} />
          </div>

          <div className="grid-2">
            <div className="panel">
              <h2>Top endpoints</h2>
              <BarList items={overview.topEndpoints.map((e) => ({ label: e.path, count: e.count }))} />
            </div>
            <div className="panel">
              <h2>Event types</h2>
              <BarList items={overview.eventTypeCounts.slice(0, 10).map((e) => ({ label: e.eventType, count: e.count }))} />
            </div>
          </div>

          <div className="panel">
            <h2>HTTP methods</h2>
            <BarList items={overview.methodBreakdown.map((m) => ({ label: m.method, count: m.count }))} />
          </div>

          {funnel && (
            <div className="panel">
              <h2>Discovery funnel</h2>
              <Funnel stages={funnel.stages} />
              <p className="muted" style={{ marginTop: ".5rem" }}>
                Each stage counts actors who reached it at least once — not a strict required sequence.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
