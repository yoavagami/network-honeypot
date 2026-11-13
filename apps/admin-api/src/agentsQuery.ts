/**
 * Pure helpers for the Agents API (routes/agents.ts) — kept free of DB imports so they are
 * unit-tested in apps/admin-api/test.
 */

export const RANGE_HOURS: Record<string, number> = { "1h": 1, "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

export function rangeHours(range: string | undefined, fallback: keyof typeof RANGE_HOURS): number {
  return RANGE_HOURS[range ?? fallback] ?? RANGE_HOURS[fallback]!;
}

/**
 * "Why" filter: case-insensitive, matches anywhere in a reason's text or its signal id. `*` is any
 * run of characters, `?` one character — "tab*hidden", "cursor_*", "KPN". `top` limits the match to
 * the two reasons the list shows.
 */
export function whyMatcher(pattern: string | undefined, scope: string | undefined) {
  const p = pattern?.trim().slice(0, 200);
  if (!p) return null;
  const body = p.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  const re = new RegExp(body, "i");
  return (reasons: Array<{ signal: string; text: string }>) =>
    (scope === "top" ? reasons.slice(0, 2) : reasons).some((r) => re.test(r.text) || re.test(r.signal));
}

export interface StoredVisitRow {
  visit_id: string; session_id: string | null; actor_id: string; first_at: Date | string; last_at: Date | string;
  request_count: number; page_count: number; lab_label: string | null; lab_verified: boolean;
  probability: number; bucket: string; type: string; agent: string | null; proven: boolean;
  reasons: Array<{ signal: string; group: string; question?: string; weight: number; text: string }>;
  ip: string | null; summary: Record<string, any>; scorer_version: string; settled: boolean; computed_at: Date | string;
}

/** visit_scores row → the list-row shape admin-web's AgentsPage renders. */
export function toVisitListRow(r: StoredVisitRow, reasonsLimit = 4) {
  const s = r.summary ?? {};
  return {
    id: r.visit_id,
    sessionId: r.session_id,
    actorId: r.actor_id,
    firstAt: new Date(r.first_at),
    lastAt: new Date(r.last_at),
    requestCount: r.request_count,
    pageCount: r.page_count,
    ip: r.ip,
    network: s.network ?? null,
    asn: s.asn ?? null,
    country: s.country ?? null,
    userAgent: s.userAgent ?? null,
    lab: r.lab_label,
    labVerified: r.lab_verified,
    ja4: s.ja4 ?? null,
    hasBrowserBeacon: Boolean(s.hasBrowserBeacon),
    unboundBeacons: Number(s.unboundBeacons ?? 0),
    shop: s.shop ?? null,
    score: {
      probability: r.probability,
      bucket: r.bucket,
      type: r.type,
      agent: r.agent,
      proven: r.proven,
      leaning: s.leaning ?? (r.probability >= 0.5 ? "agent" : "human"),
      calibrated: false as const,
      scorerVersion: r.scorer_version,
      settled: r.settled,
      computedAt: new Date(r.computed_at),
      reasons: (r.reasons ?? []).slice(0, reasonsLimit),
      checks: Array.isArray(s.checks) ? s.checks : [],
      control: s.control ?? { mode: "unknown", pages: [], jumpClicks: 0, scriptFilledFields: 0, scriptFilledPages: 0, inputlessScrollPages: 0, handover: null, agentDriven: false },
    },
  };
}

/** Lab label rule for minted links: `<agent>-<scenario>-<n>` or `human-<browser>-<n>`. */
export const LAB_RUN_LABEL_RE = /^[a-z0-9][a-z0-9.-]{0,40}-[a-z0-9][a-z0-9.-]{0,20}-\d{1,4}$/;

export interface LabRunInput { label?: unknown; kind?: unknown; agent?: unknown; scenario?: unknown; notes?: unknown; ttlDays?: unknown }
export type LabRunParsed = { label: string; kind: "agent" | "human"; agent: string | null; scenario: string | null; notes: string | null; ttlDays: number };

export function parseLabRunInput(b: LabRunInput): { ok: true; value: LabRunParsed } | { ok: false; error: string } {
  const label = typeof b.label === "string" ? b.label.trim().toLowerCase() : "";
  if (!LAB_RUN_LABEL_RE.test(label)) return { ok: false, error: "label must look like <agent>-<scenario>-<n> or human-<browser>-<n> (lowercase letters, digits, dots, dashes)" };
  const kind = b.kind === "human" ? "human" : b.kind === "agent" ? "agent" : null;
  if (!kind) return { ok: false, error: "kind must be 'agent' or 'human'" };
  if (kind === "human" && !label.startsWith("human-")) return { ok: false, error: "human control runs must be labelled human-<browser>-<n>" };
  if (kind === "agent" && label.startsWith("human-")) return { ok: false, error: "agent runs can't use the human- prefix" };
  const str = (x: unknown, n: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : null);
  const ttl = Number(b.ttlDays ?? 2);
  if (!Number.isFinite(ttl) || ttl < 1 / 24 || ttl > 30) return { ok: false, error: "ttlDays must be between 1 hour and 30 days" };
  return { ok: true, value: { label, kind, agent: str(b.agent, 60), scenario: str(b.scenario, 60), notes: str(b.notes, 500), ttlDays: ttl } };
}
