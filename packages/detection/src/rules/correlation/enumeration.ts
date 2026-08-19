import { withinWindow, type DetectionResult, type RecentRequest } from "./types.js";

const ENUM_WINDOW_MS = 5 * 60 * 1000;
const ID_ENUM_MIN_DISTINCT = 5;
const PARAM_ENUM_MIN_DISTINCT = 8;

/** ≥5 requests to the same path template with distinct `:id` values within a window. */
export function detectIdEnumeration(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, ENUM_WINDOW_MS).filter((r) => r.pathTemplate && r.pathParams.id !== undefined);
  const byTemplate = new Map<string, RecentRequest[]>();
  for (const r of window) {
    const list = byTemplate.get(r.pathTemplate!) ?? [];
    list.push(r);
    byTemplate.set(r.pathTemplate!, list);
  }

  for (const [template, reqs] of byTemplate) {
    const distinctIds = new Set(reqs.map((r) => r.pathParams.id));
    if (distinctIds.size >= ID_ENUM_MIN_DISTINCT) {
      const sortedIds = [...distinctIds].map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      const sequential = isMostlySequential(sortedIds);
      return {
        detectionType: "enumeration",
        confidence: Math.min(1, (sequential ? 0.7 : 0.5) + distinctIds.size * 0.02),
        evidence: { pathTemplate: template, distinctIds: [...distinctIds].slice(0, 50), sequential },
        eventCount: reqs.length,
        firstEventAtMs: Math.min(...reqs.map((r) => r.atMs)),
        lastEventAtMs: Math.max(...reqs.map((r) => r.atMs)),
      };
    }
  }
  return null;
}

function isMostlySequential(sorted: number[]): boolean {
  if (sorted.length < 2) return false;
  let steps = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! <= 3) steps++;
  }
  return steps / (sorted.length - 1) >= 0.6;
}

/** Same endpoint hit with ≥8 distinct values for the same query parameter within a window. */
export function detectParameterEnumeration(recent: RecentRequest[], nowMs: number): DetectionResult | null {
  const window = withinWindow(recent, nowMs, ENUM_WINDOW_MS);
  const byEndpointParam = new Map<string, Set<string>>();
  const groups = new Map<string, RecentRequest[]>();

  for (const r of window) {
    for (const [param, value] of Object.entries(r.queryParams)) {
      const key = `${r.path}::${param}`;
      const set = byEndpointParam.get(key) ?? new Set<string>();
      set.add(value);
      byEndpointParam.set(key, set);
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
  }

  for (const [key, values] of byEndpointParam) {
    if (values.size >= PARAM_ENUM_MIN_DISTINCT) {
      const reqs = groups.get(key)!;
      const [path, param] = key.split("::");
      return {
        detectionType: "enumeration",
        confidence: Math.min(1, 0.5 + values.size * 0.03),
        evidence: { path, param, distinctValueCount: values.size },
        eventCount: reqs.length,
        firstEventAtMs: Math.min(...reqs.map((r) => r.atMs)),
        lastEventAtMs: Math.max(...reqs.map((r) => r.atMs)),
      };
    }
  }
  return null;
}
