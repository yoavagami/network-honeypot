/**
 * Canary matching — checks whether any known synthetic canary value appears anywhere in a
 * request (path, query values, header values, body key values). Pure/testable; the caller
 * supplies the current list of active canary values (loaded from `canary_objects` by the app).
 */
export function findCanaryMatches(haystacks: Array<string | null | undefined>, canaryValues: string[]): string[] {
  if (canaryValues.length === 0) return [];
  const found = new Set<string>();
  for (const haystack of haystacks) {
    if (!haystack) continue;
    for (const canary of canaryValues) {
      if (haystack.includes(canary)) found.add(canary);
    }
  }
  return [...found];
}
