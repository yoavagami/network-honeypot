import type { InferInsertModel } from "drizzle-orm";
import { schema } from "@honeypot/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { metrics, recordDbWriteLatency } from "./metrics.js";
import type { Logger } from "@honeypot/logging";

type RequestRow = InferInsertModel<typeof schema.requests>;
type EventRow = InferInsertModel<typeof schema.events>;

interface QueueItem {
  kind: "request" | "event";
  row: RequestRow | EventRow;
  /** High-priority items (canary triggers, auth/admin events) are never dropped ahead of
   * low-priority ones under backpressure. See docs/ARCHITECTURE.md §5. */
  priority: "high" | "low";
}

/**
 * Bounded, batched, async event ingestion queue. Decouples request-handling latency from DB
 * write latency (the HTTP response is already sent before anything here runs) and survives
 * traffic bursts by shedding low-value event classes first under backpressure rather than
 * either blocking requests or silently losing high-value telemetry.
 */
export class IngestionQueue {
  private highPriority: QueueItem[] = [];
  private lowPriority: QueueItem[] = [];
  private flushing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  get depth(): number {
    return this.highPriority.length + this.lowPriority.length;
  }

  start() {
    this.timer = setInterval(() => {
      void this.flush();
    }, config.queueFlushIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(item: QueueItem) {
    metrics.eventsReceivedTotal += 1;
    const queue = item.priority === "high" ? this.highPriority : this.lowPriority;

    if (this.depth >= config.queueCapacity) {
      if (item.priority === "high" && this.lowPriority.length > 0) {
        // Evict the oldest low-priority item to make room for high-value telemetry.
        this.lowPriority.shift();
        metrics.eventsDroppedTotal += 1;
      } else if (item.priority === "low") {
        metrics.eventsDroppedTotal += 1;
        return; // drop this low-priority item rather than growing unbounded
      } else {
        // Even high-priority queues are full — last resort, drop oldest high-priority item,
        // but this is a genuinely exceptional overload condition.
        this.highPriority.shift();
        metrics.eventsDroppedTotal += 1;
        this.logger.warn({ msg: "high-priority queue overflow" });
      }
    }

    queue.push(item);
  }

  async flush() {
    if (this.flushing) return;
    if (this.depth === 0) return;
    this.flushing = true;
    const started = Date.now();
    try {
      const batch = [
        ...this.highPriority.splice(0, config.queueFlushBatchSize),
        ...this.lowPriority.splice(0, Math.max(0, config.queueFlushBatchSize - this.highPriority.length)),
      ];
      if (batch.length === 0) return;

      const requestRows = batch.filter((i) => i.kind === "request").map((i) => i.row as RequestRow);
      const eventRows = batch.filter((i) => i.kind === "event").map((i) => i.row as EventRow);

      if (requestRows.length > 0) await db.insert(schema.requests).values(requestRows);
      if (eventRows.length > 0) await db.insert(schema.events).values(eventRows);

      metrics.eventsProcessedTotal += batch.length;
      metrics.lastSuccessfulFlushAt = new Date().toISOString();
      recordDbWriteLatency(Date.now() - started);
    } catch (err) {
      metrics.eventsFailedTotal += 1;
      this.logger.error({ msg: "flush failed", err: err instanceof Error ? err.message : String(err) });
    } finally {
      this.flushing = false;
    }
  }
}
