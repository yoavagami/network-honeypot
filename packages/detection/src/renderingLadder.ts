/**
 * Rendering ladder — how far a client got with each page we served, from one page load.
 *
 * Every HTML response carries a server-minted page-load id and three beacons that point at it
 * (apps/honeypot/src/sensing/ladder.ts):
 *   - css      a background-image on a hidden element — fetched only by a client that computes styles
 *   - noscript an <img> inside <noscript> — fetched only when scripting is off (JS-disabled
 *              browsers, and HTML parsers, which treat <noscript> content as ordinary markup)
 *   - js       a pixel app.js requests as soon as it runs (the fp/behavior beacons count too)
 *
 * Which of them arrived places the page load on the ladder. A page load is only judged once it
 * is "settled" — 30 s old, or followed by another page — so a slow browser isn't called HTML-only.
 */

export type LadderRung = "pending" | "html_only" | "images_only" | "css_no_js" | "js_no_css" | "ran_js";

export interface ServedPage {
  /** Server-minted page-load id (request_signals.data.pageLoadId). */
  pl: string;
  path: string;
  at: string;
}

export interface LadderHit {
  pl: string;
  rung: "css" | "noscript" | "js";
  at: string;
}

export interface PageLadder {
  pl: string;
  path: string;
  at: string;
  css: boolean;
  noscript: boolean;
  js: boolean;
  settled: boolean;
  rung: LadderRung;
}

export interface RenderingLadder {
  pages: PageLadder[];
  /** Highest rung reached by any settled page load (js_no_css counts as having run JS). */
  summary: LadderRung | null;
}

export const LADDER_GRACE_MS = 30_000;

/** Order used to pick the visit's highest rung. */
const ORDER: Record<LadderRung, number> = { pending: 0, html_only: 1, images_only: 2, css_no_js: 3, js_no_css: 4, ran_js: 5 };

export function rungFor(p: { css: boolean; noscript: boolean; js: boolean; settled: boolean }): LadderRung {
  if (p.js) return p.css || !p.settled ? "ran_js" : "js_no_css";
  if (p.css) return "css_no_js";
  if (!p.settled) return "pending";
  return p.noscript ? "images_only" : "html_only";
}

export function renderingLadder(served: ServedPage[], hits: LadderHit[], nowMs: number = Date.now()): RenderingLadder {
  const byPl = new Map<string, Set<LadderHit["rung"]>>();
  for (const h of hits) {
    if (!h.pl) continue;
    const s = byPl.get(h.pl) ?? new Set();
    s.add(h.rung);
    byPl.set(h.pl, s);
  }
  const sorted = [...served].filter((p) => p.pl).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const seen = new Set<string>();
  const pages: PageLadder[] = [];
  sorted.forEach((p, i) => {
    if (seen.has(p.pl)) return;
    seen.add(p.pl);
    const got = byPl.get(p.pl) ?? new Set();
    const t = Date.parse(p.at);
    const settled = nowMs - t >= LADDER_GRACE_MS || sorted.slice(i + 1).some((q) => Date.parse(q.at) > t);
    const row = { css: got.has("css"), noscript: got.has("noscript"), js: got.has("js"), settled };
    pages.push({ pl: p.pl, path: p.path, at: p.at, ...row, rung: rungFor(row) });
  });
  const judged = pages.filter((p) => p.rung !== "pending");
  const summary = judged.length ? judged.reduce((best, p) => (ORDER[p.rung] > ORDER[best] ? p.rung : best), judged[0]!.rung) : pages.length ? "pending" : null;
  return { pages, summary };
}
