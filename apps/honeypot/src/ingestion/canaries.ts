import { eq } from "drizzle-orm";
import { schema } from "@honeypot/db";
import type { Logger } from "@honeypot/logging";
import { db } from "../db.js";
import { config } from "../config.js";

let activeCanaryValues: string[] = [];
let timer: NodeJS.Timeout | null = null;

export async function refreshCanaries() {
  const rows = await db.select({ value: schema.canaryObjects.value }).from(schema.canaryObjects).where(eq(schema.canaryObjects.active, true));
  activeCanaryValues = rows.map((r) => r.value);
}

export function getActiveCanaryValues(): string[] {
  return activeCanaryValues;
}

export function startCanaryRefresh(logger: Logger) {
  // See correlationWorker.ts's startCorrelationWorker for why this can't be a bare `void`.
  timer = setInterval(() => {
    refreshCanaries().catch((err) => {
      logger.error({ msg: "canary refresh failed", err: err instanceof Error ? err.message : String(err) });
    });
  }, config.canaryRefreshIntervalMs);
  timer.unref();
}

export function stopCanaryRefresh() {
  if (timer) clearInterval(timer);
}

const byLocationCache = new Map<string, string>();

export async function getCanaryValueForLocation(location: string): Promise<string | null> {
  if (byLocationCache.has(location)) return byLocationCache.get(location)!;
  const [row] = await db.select({ value: schema.canaryObjects.value }).from(schema.canaryObjects).where(eq(schema.canaryObjects.plantedLocation, location)).limit(1);
  if (row) byLocationCache.set(location, row.value);
  return row?.value ?? null;
}

export interface CanaryRecord {
  id: string;
  canaryType: string;
  plantedLocation: string;
}

export async function findCanaryByValue(value: string): Promise<CanaryRecord | null> {
  const [row] = await db
    .select({ id: schema.canaryObjects.canaryId, canaryType: schema.canaryObjects.canaryType, plantedLocation: schema.canaryObjects.plantedLocation })
    .from(schema.canaryObjects)
    .where(eq(schema.canaryObjects.value, value))
    .limit(1);
  return row ?? null;
}
