/**
 * Tracks which command families each (actor, path) pair has already had recognized, so a second
 * *different* command from the same actor on the same bait path can be classified as iteration
 * (BACKDOOR_COMMAND_ITERATION) rather than a fresh first touch. In-memory, not the DB — event
 * writes go through the async ingestion queue (see ingestion/queue.ts), so a DB read at request
 * time could race a not-yet-flushed write from the immediately preceding request. Same
 * per-process-lifetime tradeoff already accepted by enrichment.ts's enrichedActors Set.
 */
const seenCommands = new Map<string, Set<string>>();

function key(actorId: string, path: string): string {
  return `${actorId}:${path}`;
}

/** Records this command family as seen, and reports whether the actor had already recognized a
 * *different* family on this same path before this call — i.e. whether this is an iteration. */
export function recordCommandAndCheckIteration(actorId: string, path: string, family: string): boolean {
  const k = key(actorId, path);
  const seen = seenCommands.get(k);
  if (!seen) {
    seenCommands.set(k, new Set([family]));
    return false;
  }
  const isIteration = !seen.has(family) && seen.size > 0;
  seen.add(family);
  return isIteration;
}
