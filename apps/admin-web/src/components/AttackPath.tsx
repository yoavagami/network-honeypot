import type { TimelineEntry } from "../api.js";
import { SeverityBadge } from "./SeverityBadge.js";

// High-signal event types worth showing as their own step in the path — everything else
// (HTTP_REQUEST, HTTP_ERROR, INVALID_ROUTE, LOGIN_ATTEMPT/FAILURE, ...) already shows up via the
// request step next to it, so surfacing them again here would just be noise. See brief §39.
const NOTABLE_EVENT_TYPES = new Set([
  "CANARY_TRIGGERED",
  "ADMIN_PAGE_ACCESS",
  "SCANNER_DETECTED",
  "FUZZING_DETECTED",
  "AUTOMATION_DETECTED",
  "OBJECT_ENUMERATION",
  "HONEYPOT_TRIGGER",
  "API_DOCUMENTATION_ACCESS",
  "ROBOTS_ACCESS",
  "SITEMAP_ACCESS",
  "SQLI_PROBE",
  "SQLI_CONFIRMED",
  "DATA_EXTRACTION",
]);

interface Step {
  at: string;
  label: string;
  notable: boolean;
  severity: string | null;
}

/** Condenses the raw request/event timeline into a de-duplicated sequence of distinct steps,
 * read chronologically — the "Homepage -> robots.txt -> /admin -> CANARY" shape from the brief,
 * not a row-per-request table (that's what the Attack Timeline panel below is for). */
function buildPath(timeline: TimelineEntry[]): Step[] {
  const chronological = [...timeline].reverse(); // API returns newest-first
  const steps: Step[] = [];

  for (const entry of chronological) {
    if (entry.kind === "request") {
      steps.push({ at: entry.at, label: `${entry.method} ${entry.path} → ${entry.statusCode}`, notable: false, severity: null });
    } else if (entry.eventType && NOTABLE_EVENT_TYPES.has(entry.eventType)) {
      steps.push({ at: entry.at, label: entry.eventType, notable: true, severity: entry.severity });
    }
  }

  // Collapse immediate repeats (e.g. a scanner hitting the same 404 path five times in a row) —
  // the point of a path visualization is the shape of the journey, not every repetition.
  const collapsed: Step[] = [];
  for (const step of steps) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.label === step.label) continue;
    collapsed.push(step);
  }

  const MAX_STEPS = 40;
  return collapsed.length > MAX_STEPS ? collapsed.slice(-MAX_STEPS) : collapsed;
}

export function AttackPath({ timeline }: { timeline: TimelineEntry[] }) {
  const steps = buildPath(timeline);
  if (steps.length === 0) return <p className="muted">Not enough activity yet to show a path.</p>;

  return (
    <div>
      {steps.map((step, i) => (
        <div key={i}>
          <div style={{ display: "flex", alignItems: "center", gap: ".5rem", padding: ".3rem 0" }}>
            <span className="mono" style={{ fontSize: ".78rem" }}>
              {step.notable ? <SeverityBadge severity={step.severity} /> : null} {step.label}
            </span>
          </div>
          {i < steps.length - 1 && <div style={{ marginLeft: "6px", color: "var(--text-muted)", fontSize: ".8rem" }}>↓</div>}
        </div>
      ))}
    </div>
  );
}
