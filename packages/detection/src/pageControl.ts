/**
 * Who was driving each page load: an agent, a person, both, or unknown. The visit's control mode
 * follows from the order: "agent → human" is the typical agentic-commerce handover (an agent
 * browses and fills checkout, a person approves and pays), "human → agent" is a session handed
 * to automation part-way. Summing a mixed visit into one score hides both sides, so the score
 * uses this to stop a person's mouse movement from cancelling the agent's evidence.
 *
 * Pure function over the behaviour beacons the page script already sends (one latest snapshot
 * per page load — agentScore.ts's latestPerPage).
 */

export type PageDriver = "agent" | "human" | "both" | "unknown";
export type ControlMode = "agent" | "human" | "agent_then_human" | "human_then_agent" | "mixed" | "unknown";

export interface PageControl {
  pl: string | null;
  path: string | null;
  /** When the page's first report arrived (ISO); older data: beacon time minus its page clock. */
  at: string | null;
  driver: PageDriver;
  agentSigns: string[];
  humanSigns: string[];
}
export interface ControlSummary {
  mode: ControlMode;
  pages: PageControl[];
  /** Totals across the visit, for the score. */
  jumpClicks: number;
  scriptFilledFields: number;
  scriptFilledPages: number;
  /** Fields the browser autofilled (trusted, no inputType, :autofill), SDK 1.2.1+. */
  autofilledFields: number;
  inputlessScrollPages: number;
  /** Where control changed hands (first page of the second driver). */
  handover: { at: string | null; path: string | null; from: "agent" | "human"; to: "agent" | "human" } | null;
  /** True when there is enough agent evidence that human-input credit shouldn't cancel it. */
  agentDriven: boolean;
}

const startMs = (b: Record<string, any>): number | null => {
  const first = typeof b.firstAt === "string" ? Date.parse(b.firstAt) : NaN;
  if (Number.isFinite(first)) return first;
  const at = typeof b.at === "string" ? Date.parse(b.at) : NaN;
  if (!Number.isFinite(at)) return null;
  const clientT = Number(b.clientT);
  return Number.isFinite(clientT) && clientT > 0 ? at - clientT : at;
};

/**
 * A "jump click": the cursor arrived on the target with at most one mouse event and was clicked
 * within 50 ms — automation moves then clicks; a person's hand travels there over many events.
 * Keyboard-activated clicks (detail 0 / 0,0 coordinates) and touch/pen taps have no mouse path
 * by nature and are excluded.
 */
export function isJumpClick(c: Record<string, any>): boolean {
  if (c.trusted === false) return false; // counted separately as synthetic_clicks
  if (c.zeroCoords || c.detail === 0) return false;
  if (c.pointer === "touch" || c.pointer === "pen") return false;
  const moves = typeof c.movesLast1s === "number" ? c.movesLast1s : null;
  const since = typeof c.msSinceMove === "number" ? c.msSinceMove : null;
  return moves !== null && moves <= 1 && since !== null && since <= 50;
}

export function pageControl(behaviors: Array<Record<string, any>>): ControlSummary {
  const pages: PageControl[] = [];
  let jumpClicks = 0;
  let scriptFilledFields = 0;
  let scriptFilledPages = 0;
  let autofilledFields = 0;
  let inputlessScrollPages = 0;

  for (const b of behaviors) {
    const B = b.behavior ?? {};
    const clicks: Array<Record<string, any>> = Array.isArray(B.clicks) ? B.clicks : [];
    const moves = Number(B.mouseMoves) || 0;
    const distance = Number(B.mouseDistance) || 0;
    const keys = Number(B.keyDowns) || 0;
    const pastes = Number(B.pastes) || 0;
    const wheels = Number(B.wheels) || 0;
    const touches = Number(B.touches) || 0;
    const scrolls = Number(B.scrolls) || 0;
    const agentSigns: string[] = [];
    const humanSigns: string[] = [];

    const jumps = clicks.filter(isJumpClick).length;
    if (jumps) {
      jumpClicks += jumps;
      agentSigns.push(`${jumps} jump click${jumps > 1 ? "s" : ""}`);
    }
    // `input` events without an inputType come from two sources: browser autofill (Chrome and
    // Safari fire a plain, *trusted* input event) and a value set by code followed by a dispatched
    // Event("input") (always untrusted). SDK 1.2.1+ counts the two apart; older snapshots only have
    // the total, so the old rule (every untyped event is a script) applies to them. Only counted
    // when nothing on the page was typed or pasted.
    const split = typeof B.untypedUntrusted === "number";
    const untyped = split ? Number(B.untypedUntrusted) || 0 : Number(B.inputs?.none) || 0;
    const autofilled = split ? Math.max(Number(B.autofilled) || 0, Number(B.untypedTrusted) || 0) : 0;
    if (autofilled) {
      autofilledFields += autofilled;
      humanSigns.push(`${autofilled} field${autofilled > 1 ? "s" : ""} autofilled by the browser`);
    }
    if (untyped >= 3 && keys === 0 && pastes === 0) {
      scriptFilledFields += untyped;
      scriptFilledPages++;
      agentSigns.push(`${untyped} fields filled with no key presses`);
    }
    // Scrolled, but by nothing a person uses: no wheel/trackpad, keys, touch or mouse (dragging the
    // scrollbar moves the mouse). That's element.scrollIntoView / window.scrollTo.
    if (scrolls >= 5 && wheels === 0 && touches === 0 && keys === 0 && moves <= 2) {
      inputlessScrollPages++;
      agentSigns.push(`${scrolls} scrolls with no wheel, key, touch or mouse`);
    }
    const humanClicks = clicks.filter((c) => c.trusted !== false && (c.movesLast1s ?? 0) >= 5).length;
    if (moves >= 20 && distance >= 300) humanSigns.push(`${moves} mouse moves over ${Math.round(distance)} px`);
    if (wheels >= 2) humanSigns.push(`${wheels} wheel/trackpad scrolls`);
    if (touches > 0) humanSigns.push("touch input");
    if (humanClicks) humanSigns.push(`${humanClicks} click${humanClicks > 1 ? "s" : ""} after a mouse path`);

    const driver: PageDriver = agentSigns.length && humanSigns.length ? "both" : agentSigns.length ? "agent" : humanSigns.length ? "human" : "unknown";
    const s = startMs(b);
    pages.push({ pl: typeof b.pl === "string" ? b.pl : null, path: typeof b.path === "string" ? b.path : null, at: s === null ? null : new Date(s).toISOString(), driver, agentSigns, humanSigns });
  }
  pages.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  // Enough that it isn't one stray click: two jump clicks, a script-filled form, or a jump click
  // plus input-less scrolling.
  const agentDriven = jumpClicks >= 2 || scriptFilledPages >= 1 || (jumpClicks >= 1 && inputlessScrollPages >= 1);

  const isAgent = (p: PageControl) => p.driver === "agent";
  const isHuman = (p: PageControl) => p.driver === "human";
  const firstAgent = pages.findIndex(isAgent);
  const firstHuman = pages.findIndex(isHuman);
  const lastAgent = pages.map(isAgent).lastIndexOf(true);
  const lastHuman = pages.map(isHuman).lastIndexOf(true);
  let mode: ControlMode = "unknown";
  let handover: ControlSummary["handover"] = null;
  if (!agentDriven) {
    mode = firstHuman >= 0 ? "human" : "unknown";
  } else if (firstHuman < 0 && !pages.some((p) => p.driver === "both")) {
    mode = "agent";
  } else if (firstHuman >= 0 && firstAgent >= 0 && lastAgent < firstHuman) {
    mode = "agent_then_human";
    handover = { at: pages[firstHuman]!.at, path: pages[firstHuman]!.path, from: "agent", to: "human" };
  } else if (firstHuman >= 0 && firstAgent >= 0 && lastHuman < firstAgent) {
    mode = "human_then_agent";
    handover = { at: pages[firstAgent]!.at, path: pages[firstAgent]!.path, from: "human", to: "agent" };
  } else {
    mode = "mixed";
  }
  return { mode, pages, jumpClicks, scriptFilledFields, scriptFilledPages, autofilledFields, inputlessScrollPages, handover, agentDriven };
}
