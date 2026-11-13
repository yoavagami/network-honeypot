/**
 * Phase 0 of the agent-sensing upgrade: compare what the in-page script reported with what the
 * server saw for the same visit, and derive environment / input facts from fields the collector
 * already sends but the score didn't use yet. Pure functions — the score (agentScore.ts) turns
 * the results into weighted reasons, and the dashboard shows the same rows as a table.
 */

export type CheckStatus = "match" | "mismatch" | "unknown";
export interface ConsistencyCheck {
  id: "user_agent" | "language" | "os" | "client_hints_platform" | "timezone_country" | "fingerprint_stable" | "browser_identity";
  label: string;
  page: string | null;
  server: string | null;
  status: CheckStatus;
}

/** Best-known country for common IANA zones. Zones not listed are simply not compared. */
const TZ_COUNTRY: Record<string, string[]> = {
  "Europe/Amsterdam": ["NL"], "Europe/Brussels": ["BE"], "Europe/Berlin": ["DE"], "Europe/Paris": ["FR"], "Europe/London": ["GB"],
  "Europe/Dublin": ["IE"], "Europe/Madrid": ["ES"], "Europe/Lisbon": ["PT"], "Europe/Rome": ["IT"], "Europe/Zurich": ["CH"],
  "Europe/Vienna": ["AT"], "Europe/Stockholm": ["SE"], "Europe/Oslo": ["NO"], "Europe/Copenhagen": ["DK"], "Europe/Helsinki": ["FI"],
  "Europe/Warsaw": ["PL"], "Europe/Prague": ["CZ"], "Europe/Budapest": ["HU"], "Europe/Bucharest": ["RO"], "Europe/Athens": ["GR"],
  "Europe/Istanbul": ["TR"], "Europe/Kiev": ["UA"], "Europe/Kyiv": ["UA"], "Europe/Moscow": ["RU"], "Europe/Luxembourg": ["LU"],
  "Asia/Jerusalem": ["IL"], "Asia/Tel_Aviv": ["IL"], "Asia/Dubai": ["AE"], "Asia/Kolkata": ["IN"], "Asia/Calcutta": ["IN"],
  "Asia/Singapore": ["SG"], "Asia/Hong_Kong": ["HK"], "Asia/Shanghai": ["CN"], "Asia/Tokyo": ["JP"], "Asia/Seoul": ["KR"],
  "Asia/Taipei": ["TW"], "Asia/Bangkok": ["TH"], "Asia/Jakarta": ["ID"], "Asia/Manila": ["PH"], "Asia/Ho_Chi_Minh": ["VN"],
  "Asia/Tehran": ["IR"], "Asia/Karachi": ["PK"], "Asia/Dhaka": ["BD"], "Asia/Riyadh": ["SA"],
  "Australia/Sydney": ["AU"], "Australia/Melbourne": ["AU"], "Australia/Brisbane": ["AU"], "Australia/Perth": ["AU"], "Pacific/Auckland": ["NZ"],
  "America/New_York": ["US"], "America/Chicago": ["US"], "America/Denver": ["US"], "America/Phoenix": ["US"], "America/Los_Angeles": ["US"],
  "America/Anchorage": ["US"], "Pacific/Honolulu": ["US"], "America/Detroit": ["US"], "America/Toronto": ["CA"], "America/Vancouver": ["CA"],
  "America/Mexico_City": ["MX"], "America/Sao_Paulo": ["BR"], "America/Argentina/Buenos_Aires": ["AR"], "America/Bogota": ["CO"],
  "America/Santiago": ["CL"], "America/Lima": ["PE"], "Africa/Johannesburg": ["ZA"], "Africa/Lagos": ["NG"], "Africa/Cairo": ["EG"], "Africa/Nairobi": ["KE"],
};
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Universal", "Universal", "Zulu"]);

export function isUtcZone(tz: unknown): boolean {
  return typeof tz === "string" && UTC_ZONES.has(tz);
}

type Os = "windows" | "mac" | "linux" | "android" | "ios" | "chromeos";
export function osFromUserAgent(ua: string | null | undefined): Os | null {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows NT/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Linux|X11/.test(ua)) return "linux";
  return null;
}
/** navigator.platform ("Win32", "MacIntel", "Linux x86_64", "iPhone", …). */
export function osFromPlatform(p: string | null | undefined): Os | null {
  if (!p) return null;
  if (/^Win/i.test(p)) return "windows";
  if (/^Mac/i.test(p)) return "mac";
  if (/iPhone|iPad|iPod/i.test(p)) return "ios";
  if (/Android/i.test(p)) return "android";
  if (/Linux|X11|armv/i.test(p)) return "linux";
  return null;
}
/** Client-hints platform ("Windows", "macOS", "Linux", "Android", "Chrome OS", "iOS"). */
function osFromHintPlatform(p: string | null | undefined): Os | null {
  if (!p) return null;
  const v = p.replace(/"/g, "").toLowerCase();
  if (v === "windows") return "windows";
  if (v === "macos") return "mac";
  if (v === "linux") return "linux";
  if (v === "android") return "android";
  if (v === "ios") return "ios";
  if (v === "chrome os" || v === "chromeos") return "chromeos";
  return null;
}
/** Android reports "Linux armv8l" as navigator.platform; ChromeOS reports Linux too. */
function osCompatible(a: Os, b: Os): boolean {
  if (a === b) return true;
  const linuxLike = (o: Os) => o === "linux" || o === "android" || o === "chromeos";
  return linuxLike(a) && linuxLike(b);
}

const primaryLang = (s: string | null | undefined) => (s ? s.split(",")[0]!.split(";")[0]!.trim().toLowerCase().split("-")[0]! || null : null);

export interface ConsistencyInput {
  /** Every fp beacon of the visit. */
  fingerprints: Array<Record<string, any>>;
  /** Header user-agents / Accept-Language values seen on the visit's requests. */
  headerUserAgents: string[];
  acceptLanguages: string[];
  ipCountry: string | null;
  /** True when the IP is a VPN/proxy edge — a timezone mismatch then means little. */
  viaProxy: boolean;
}

export function consistencyChecks(input: ConsistencyInput): ConsistencyCheck[] {
  const fps = input.fingerprints;
  const fp = fps[0];
  if (!fp) return [];
  const out: ConsistencyCheck[] = [];
  const pageUa: string | null = typeof fp.nav?.ua === "string" ? fp.nav.ua : null;

  // 1. The UA the page script reads vs. the UA header on the requests.
  if (pageUa && input.headerUserAgents.length) {
    const same = input.headerUserAgents.includes(pageUa);
    out.push({ id: "user_agent", label: "User-agent: page vs. request header", page: pageUa, server: input.headerUserAgents[0]!, status: same ? "match" : "mismatch" });
  }

  // 2. navigator.languages[0] vs. Accept-Language (primary subtag only: "en-US" ≈ "en-GB").
  const langs: unknown = fp.nav?.languages;
  const pageLang = Array.isArray(langs) && typeof langs[0] === "string" ? langs[0] : null;
  const headerLang = input.acceptLanguages[0] ?? null;
  if (pageLang && headerLang) {
    out.push({ id: "language", label: "Language: page vs. Accept-Language", page: pageLang, server: headerLang.slice(0, 60), status: primaryLang(pageLang) === primaryLang(headerLang) ? "match" : "mismatch" });
  }

  // 3. OS in the user-agent vs. navigator.platform (cloud agents often swap the UA only).
  const uaOs = osFromUserAgent(pageUa ?? input.headerUserAgents[0]);
  const platOs = osFromPlatform(fp.nav?.platform);
  if (uaOs && platOs) {
    out.push({ id: "os", label: "Operating system: user-agent vs. navigator.platform", page: String(fp.nav.platform), server: uaOs, status: osCompatible(uaOs, platOs) ? "match" : "mismatch" });
  }

  // 4. Client-hints platform (navigator.userAgentData) vs. the user-agent's OS.
  const hintOs = osFromHintPlatform(fp.uaData?.low?.platform ?? fp.uaData?.platform);
  if (uaOs && hintOs) {
    out.push({ id: "client_hints_platform", label: "Client hints platform vs. user-agent", page: String(fp.uaData?.low?.platform ?? fp.uaData?.platform), server: uaOs, status: osCompatible(uaOs, hintOs) ? "match" : "mismatch" });
  }

  // 5. Browser timezone vs. the country of the connecting IP.
  const tz: string | null = typeof fp.intl?.tz === "string" ? fp.intl.tz : null;
  if (tz && input.ipCountry && input.ipCountry.length === 2) {
    const countries = TZ_COUNTRY[tz];
    let status: CheckStatus = "unknown";
    if (countries) status = countries.includes(input.ipCountry.toUpperCase()) ? "match" : input.viaProxy ? "unknown" : "mismatch";
    out.push({ id: "timezone_country", label: "Timezone vs. IP country", page: tz, server: input.ipCountry, status });
  }

  // 6. The device should look the same on every page of one visit.
  if (fps.length >= 2) {
    const keys = fps.map((f) => [f.webgl?.renderer ?? "", f.canvas ?? "", f.screen ? `${f.screen.w}x${f.screen.h}` : "", f.nav?.platform ?? ""].join("|"));
    const distinct = new Set(keys).size;
    out.push({ id: "fingerprint_stable", label: "Device fingerprint across page loads", page: `${distinct} distinct of ${fps.length} page loads`, server: null, status: distinct === 1 ? "match" : "mismatch" });
  }

  // 7. The browser the user-agent claims vs. the fixed traits every real copy of it has.
  const ident = browserIdentity(fp, pageUa ?? input.headerUserAgents[0] ?? null);
  if (ident) {
    out.push({
      id: "browser_identity", label: "Browser traits vs. claimed browser",
      page: ident.wrong.length ? ident.wrong.join("; ") : "vendor, productSub, engine objects as expected",
      server: ident.claimed, status: ident.wrong.length ? "mismatch" : "match",
    });
  }
  return out;
}

export type BrowserEngine = "chromium" | "firefox" | "safari";
/** Engine a user-agent claims. Chrome/Firefox/Edge on iOS are WebKit underneath. */
export function claimedEngine(ua: string | null | undefined): BrowserEngine | null {
  if (!ua) return null;
  if (/iPhone|iPad|iPod/.test(ua) || /CriOS|FxiOS|EdgiOS/.test(ua)) return /AppleWebKit/.test(ua) ? "safari" : null;
  if (/Firefox\//.test(ua) && !/Seamonkey/i.test(ua)) return "firefox";
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "safari";
  return null;
}

/**
 * Every Chrome reports vendor "Google Inc." and productSub "20030107", has window.chrome on
 * desktop and navigator.userAgentData; Firefox has an empty vendor, productSub "20100101", a
 * buildID and no userAgentData; Safari reports "Apple Computer, Inc." and has neither
 * userAgentData nor window.chrome. A user-agent swapped without the rest breaks these.
 */
export function browserIdentity(fp: Record<string, any>, ua: string | null): { claimed: string; wrong: string[] } | null {
  const engine = claimedEngine(ua);
  const nav = fp.nav ?? {};
  if (!engine || nav.vendor === undefined) return null; // older beacons didn't include these fields
  const wrong: string[] = [];
  const vendor = nav.vendor == null ? null : String(nav.vendor);
  const productSub = nav.productSub == null ? null : String(nav.productSub);
  const hasChromeObj = fp.automation?.chrome != null;
  const hasUaData = fp.uaData != null;
  const hasBuildId = nav.buildID != null && nav.buildID !== "";
  const mobile = /Mobile|Android/.test(String(ua));
  if (engine === "chromium") {
    if (vendor !== null && vendor !== "Google Inc.") wrong.push(`vendor "${vendor}" (Chrome says "Google Inc.")`);
    if (productSub !== null && productSub !== "20030107") wrong.push(`productSub ${productSub} (Chrome: 20030107)`);
    if (hasBuildId) wrong.push("has Firefox's navigator.buildID");
    if (!hasChromeObj && !mobile) wrong.push("no window.chrome object");
  } else if (engine === "firefox") {
    if (vendor) wrong.push(`vendor "${vendor}" (Firefox's is empty)`);
    if (productSub !== null && productSub !== "20100101") wrong.push(`productSub ${productSub} (Firefox: 20100101)`);
    if (hasUaData) wrong.push("has Chromium's userAgentData");
    if (hasChromeObj) wrong.push("has a window.chrome object");
  } else {
    if (vendor !== null && vendor !== "Apple Computer, Inc.") wrong.push(`vendor "${vendor}" (Safari says "Apple Computer, Inc.")`);
    if (hasUaData) wrong.push("has Chromium's userAgentData");
    if (hasChromeObj) wrong.push("has a window.chrome object");
    if (hasBuildId) wrong.push("has Firefox's navigator.buildID");
  }
  return { claimed: engine === "chromium" ? "Chrome / Chromium" : engine === "firefox" ? "Firefox" : "Safari (WebKit)", wrong };
}

/** Virtual-machine / server tells from fields the collector already sends. */
export interface EnvironmentFacts {
  tells: string[];
  utcTimezone: boolean;
}
export function environmentFacts(fps: Array<Record<string, any>>): EnvironmentFacts {
  const tells = new Set<string>();
  let utc = false;
  for (const fp of fps) {
    if (isUtcZone(fp.intl?.tz)) utc = true;
    // Not used, checked against live data (2026-11-13): voices are 0 for everyone (Chrome fills
    // getVoices() asynchronously), and "no media devices" and the notification-permission
    // contradiction show up on most real Chrome visitors too.
    const cores = Number(fp.nav?.hardwareConcurrency);
    if (Number.isFinite(cores) && cores > 0 && cores <= 2) tells.add(`${cores} CPU core${cores === 1 ? "" : "s"}`);
    const mem = Number(fp.nav?.deviceMemory);
    if (Number.isFinite(mem) && mem > 0 && mem < 2) tells.add(`${mem} GB device memory`);
    if (fp.nav?.pdfViewerEnabled === false && claimedEngine(fp.nav?.ua) === "chromium" && !/Mobile|Android/.test(String(fp.nav?.ua ?? ""))) tells.add("PDF viewer disabled in desktop Chrome");
    if (Array.isArray(fp.nav?.plugins) && fp.nav.plugins.length === 0 && /Chrome\//.test(String(fp.nav?.ua ?? "")) && !/Mobile|Android/.test(String(fp.nav?.ua ?? ""))) tells.add("desktop Chrome with no PDF plugins");
  }
  return { tells: [...tells], utcTimezone: utc };
}

/** Facts about clicks and typing from the behaviour beacons. */
export interface InputFacts {
  trustedClicks: number;
  centredClicks: number;
  clickSpread: number | null;
  printableKeys: number;
  correctionKeys: number;
  modifierKeys: number;
  pastes: number;
  keyDowns: number;
  /** "Think, then act": a long gap since the previous click with the cursor still, then a jump onto the target. */
  clickGaps: number;
  thinkPauses: number;
  medianThinkPauseMs: number | null;
}
export function inputFacts(behaviors: Array<Record<string, any>>): InputFacts {
  // Behaviour beacons are cumulative snapshots per page load; the last one per page holds the
  // full counts, but clicks are capped at 25 per page, so de-duplicate by (t, x, y).
  const seen = new Set<string>();
  const offsets: Array<{ dx: number; dy: number }> = [];
  let trusted = 0;
  for (const b of behaviors) {
    for (const c of Array.isArray(b.behavior?.clicks) ? b.behavior.clicks : []) {
      const key = `${b.path ?? ""}|${c.t}|${c.x}|${c.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (c.trusted === false) continue;
      trusted++;
      if (typeof c.dx === "number" && typeof c.dy === "number" && !c.zeroCoords) offsets.push({ dx: c.dx, dy: c.dy });
    }
  }
  // Gaps between consecutive trusted clicks on the same page load. A screen-driving AI agent
  // takes a screenshot, waits seconds for the model, then moves straight to the target and
  // clicks (≤2 mouse moves in the last second). People move the mouse while they read.
  let gaps = 0;
  const pauses: number[] = [];
  // An agent that clicks once per page (each click navigates) only shows its rhythm across page
  // loads, so clicks are placed on one visit timeline when the beacon carries its arrival time
  // (`at`) and page clock (`clientT`); older data falls back to gaps within one page.
  const groups = new Map<string, Array<{ abs: number; moves: number }>>();
  for (const b of behaviors) {
    const at = typeof b.at === "string" ? Date.parse(b.at) : NaN;
    const clientT = Number(b.clientT);
    const start = Number.isFinite(at) && Number.isFinite(clientT) ? at - clientT : null;
    const key = start === null ? `page:${b.pl ?? b.path ?? ""}` : "visit";
    const list = groups.get(key) ?? [];
    for (const c of Array.isArray(b.behavior?.clicks) ? b.behavior.clicks : []) {
      if (c.trusted === false || typeof c.t !== "number") continue;
      list.push({ abs: (start ?? 0) + c.t, moves: typeof c.movesLast1s === "number" ? c.movesLast1s : 99 });
    }
    groups.set(key, list);
  }
  for (const cs of groups.values()) {
    cs.sort((x, y) => x.abs - y.abs);
    for (let i = 1; i < cs.length; i++) {
      const gap = cs[i]!.abs - cs[i - 1]!.abs;
      if (gap < 300) continue; // double-clicks and click bursts aren't decisions
      if (gap > 120_000) continue; // the visitor walked away; not a decision pause
      gaps++;
      if (gap >= 2000 && cs[i]!.moves <= 2) pauses.push(gap);
    }
  }
  pauses.sort((a, b) => a - b);
  const centred = offsets.filter((o) => Math.abs(o.dx) <= 0.04 && Math.abs(o.dy) <= 0.06).length;
  let spread: number | null = null;
  if (offsets.length >= 3) {
    const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
    const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
    spread = Math.round(Math.max(sd(offsets.map((o) => o.dx)), sd(offsets.map((o) => o.dy))) * 1000) / 1000;
  }
  // Counters are cumulative per page load: take the max per page (path) and sum across pages.
  const perPage = new Map<string, Record<string, number>>();
  for (const b of behaviors) {
    const k = String(b.path ?? "") + "|" + String(b.pl ?? "");
    const cur = perPage.get(k) ?? {};
    const kk = b.behavior?.keyKinds ?? {};
    const vals: Record<string, number> = {
      printable: Number(kk.printable) || 0, nav: Number(kk.nav) || 0, modifier: Number(kk.modifier) || 0,
      pastes: Number(b.behavior?.pastes) || 0, keyDowns: Number(b.behavior?.keyDowns) || 0,
    };
    for (const [n, v] of Object.entries(vals)) cur[n] = Math.max(cur[n] ?? 0, v);
    perPage.set(k, cur);
  }
  const total = (n: string) => [...perPage.values()].reduce((a, p) => a + (p[n] ?? 0), 0);
  return {
    trustedClicks: trusted, centredClicks: centred, clickSpread: spread,
    printableKeys: total("printable"), correctionKeys: total("nav"), modifierKeys: total("modifier"),
    pastes: total("pastes"), keyDowns: total("keyDowns"),
    clickGaps: gaps, thinkPauses: pauses.length, medianThinkPauseMs: pauses.length ? pauses[Math.floor(pauses.length / 2)]! : null,
  };
}
