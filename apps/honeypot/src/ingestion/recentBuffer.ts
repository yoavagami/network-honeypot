import type { RecentRequest } from "@honeypot/detection";

export interface ObservedRequest extends RecentRequest {
  username?: string;
  authEventType?: "LOGIN_FAILURE" | "PASSWORD_RESET_ATTEMPT";
  riskScore: number;
}

const MAX_PER_ACTOR = 500;
const MAX_AGE_MS = 15 * 60 * 1000;

/**
 * In-memory sliding window per actor, feeding the Tier-2 correlation rules
 * (docs/DETECTION.md §2) without re-querying Postgres on every correlation tick for actors
 * that are actively being observed. Bounded per-actor and by age so it can't grow unbounded.
 */
class RecentBuffer {
  private byActor = new Map<string, ObservedRequest[]>();

  record(actorId: string, entry: ObservedRequest) {
    const list = this.byActor.get(actorId) ?? [];
    list.push(entry);
    const cutoff = entry.atMs - MAX_AGE_MS;
    const trimmed = list.filter((e) => e.atMs >= cutoff).slice(-MAX_PER_ACTOR);
    this.byActor.set(actorId, trimmed);
  }

  get(actorId: string): ObservedRequest[] {
    return this.byActor.get(actorId) ?? [];
  }

  activeActorIds(): string[] {
    return [...this.byActor.keys()];
  }

  /** Periodic cleanup for actors that have gone fully idle, to bound total memory use. */
  sweep(nowMs: number) {
    for (const [actorId, list] of this.byActor) {
      const fresh = list.filter((e) => nowMs - e.atMs <= MAX_AGE_MS);
      if (fresh.length === 0) this.byActor.delete(actorId);
      else this.byActor.set(actorId, fresh);
    }
  }
}

export const recentBuffer = new RecentBuffer();
