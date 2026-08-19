/**
 * Ingestion health metrics — see docs/ARCHITECTURE.md §11. This is the mechanism that makes
 * "100,000 requests received but only 5,000 recorded" a visible, alertable condition instead of
 * a silent failure.
 */
export const metrics = {
  eventsReceivedTotal: 0,
  eventsProcessedTotal: 0,
  eventsDroppedTotal: 0,
  eventsFailedTotal: 0,
  requestsTotal: 0,
  lastSuccessfulFlushAt: null as string | null,
  dbWriteLatencyMsSamples: [] as number[],
};

export function recordDbWriteLatency(ms: number) {
  metrics.dbWriteLatencyMsSamples.push(ms);
  if (metrics.dbWriteLatencyMsSamples.length > 200) metrics.dbWriteLatencyMsSamples.shift();
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function snapshotMetrics(queueDepth: number, queueCapacity: number) {
  return {
    events_received_total: metrics.eventsReceivedTotal,
    events_processed_total: metrics.eventsProcessedTotal,
    events_dropped_total: metrics.eventsDroppedTotal,
    events_failed_total: metrics.eventsFailedTotal,
    requests_total: metrics.requestsTotal,
    queue_depth: queueDepth,
    queue_capacity: queueCapacity,
    db_write_latency_ms_p50: percentile(metrics.dbWriteLatencyMsSamples, 50),
    db_write_latency_ms_p95: percentile(metrics.dbWriteLatencyMsSamples, 95),
    db_write_latency_ms_p99: percentile(metrics.dbWriteLatencyMsSamples, 99),
    last_successful_flush_at: metrics.lastSuccessfulFlushAt,
  };
}
