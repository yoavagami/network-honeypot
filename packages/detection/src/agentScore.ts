import { classifyOrigin, type InfraCategory } from "./infraClassification.js";
import { consistencyChecks, environmentFacts, inputFacts, type ConsistencyCheck, type EnvironmentFacts, type InputFacts } from "./pageConsistency.js";

/**
 * Visit-level "was this an AI agent?" score for the admin dashboard's Agents page.
 *
 * Each observed signal adds log-odds toward "AI agent" (positive) or "human / not an AI agent"
 * (negative), starting from a prior; the sum is squashed into a probability, and the per-signal
 * contributions *are* the explanation. Proof outranks the sum: a verified signature / operator
 * IP list / a known agent's DOM marker settles identity outright.
 *
 * The weights are judgment calls until tuned against labeled lab runs (?lab=...), so the
 * dashboard shows the score as uncalibrated. Pure function over already-captured data — no DB,
 * no I/O — so it re-scores history instantly when a weight changes.
 */

export type AgentBucket = "ai_agent" | "probably_ai_agent" | "not_sure" | "not_ai_agent";
export type AgentType =
  | "cloud_browser_agent"
  | "in_browser_agent"
  | "user_triggered_fetcher"
  | "ai_crawler"
  | "search_crawler"
  | "ai_app"
  | "browser_automation"
  | "script"
  | "scanner"
  | "human";

export interface ScoreReason {
  signal: string;
  group: "proof" | "network" | "request" | "browser" | "behavior" | "journey";
  weight: number;
  text: string;
}

export interface AgentScore {
  probability: number;
  bucket: AgentBucket;
  type: AgentType;
  agent: string | null;
  proven: boolean;
  leaning: "agent" | "human";
  reasons: ScoreReason[];
  calibrated: false;
  /** Server-vs-page comparisons (pageConsistency.ts) — shown as a table on the visit page. */
  checks: ConsistencyCheck[];
  environment: EnvironmentFacts;
  input: InputFacts;
}

/** One request's server-side view (request_signals + requests). */
export interface RequestEvidence {
  at: string;
  method: string;
  path: string;
  status: number;
  verdict: string;
  agent: string | null;
  verdictMethod: string | null;
  verdictReasons: string[];
  uaLibrary: string | null;
  aiApp: string | null;
  browserFamily: string | null;
  consistencyFlags: string[];
  tor: boolean;
  isHtmlPage: boolean;
  isAsset: boolean;
  probing: boolean;
  /** Raw User-Agent / Accept-Language headers, for the server-vs-page checks. */
  userAgent?: string | null;
  acceptLanguage?: string | null;
}

/** What the in-page collector reported (client_signals). */
export interface ClientEvidence {
  fingerprints: Array<Record<string, any>>;
  behaviors: Array<Record<string, any>>;
}

export interface VisitEvidence {
  requests: RequestEvidence[];
  client: ClientEvidence;
  asn: string | null;
  organization: string | null;
  shopEvents: string[];
  /** ISO country of the connecting IP (actors.country). */
  country?: string | null;
}

/** AI-operator agents (from the sensing registry) vs. classic search crawlers. */
const AGENT_KIND: Record<string, AgentType> = {
  "chatgpt-agent": "cloud_browser_agent",
  "google-agent": "cloud_browser_agent",
  "chatgpt-user": "user_triggered_fetcher",
  "claude-user": "user_triggered_fetcher",
  "claude-code": "user_triggered_fetcher",
  "google-user-fetch": "user_triggered_fetcher",
  "perplexity-user": "user_triggered_fetcher",
  "gemini-notebook": "user_triggered_fetcher",
  "meta-externalfetcher": "user_triggered_fetcher",
  "mistral-user": "user_triggered_fetcher",
  "duckassistbot": "user_triggered_fetcher",
  gptbot: "ai_crawler",
  "oai-searchbot": "ai_crawler",
  "oai-adsbot": "ai_crawler",
  claudebot: "ai_crawler",
  "claude-searchbot": "ai_crawler",
  perplexitybot: "ai_crawler",
  "meta-externalagent": "ai_crawler",
  grokbot: "ai_crawler",
  bytespider: "ai_crawler",
  ccbot: "ai_crawler",
  cohere: "ai_crawler",
  youbot: "ai_crawler",
  qwenbot: "ai_crawler",
  kimi: "ai_crawler",
  chatglm: "ai_crawler",
  diffbot: "ai_crawler",
  ai2bot: "ai_crawler",
  amazonbot: "ai_crawler",
  googlebot: "search_crawler",
  bingbot: "search_crawler",
  applebot: "search_crawler",
  bravebot: "search_crawler",
  petalbot: "search_crawler",
  browserbase: "cloud_browser_agent",
  "anchor-browser": "cloud_browser_agent",
  goose: "cloud_browser_agent",
  "cloudflare-browser-rendering": "cloud_browser_agent",
  // ranges named by file when no UA claim was made
  "openai-chatgpt-user": "user_triggered_fetcher",
  "openai-gptbot": "ai_crawler",
  "openai-searchbot": "ai_crawler",
  "openai-adsbot": "ai_crawler",
  "anthropic-bots": "user_triggered_fetcher",
  "perplexity-perplexity-user": "user_triggered_fetcher",
  "perplexity-perplexitybot": "ai_crawler",
  "google-user-triggered-agents": "cloud_browser_agent",
  "google-user-triggered-fetchers": "user_triggered_fetcher",
};

const KNOWN_ARTIFACT_AGENT: Record<string, string> = {
  "claude-in-chrome": "claude-in-chrome",
  "perplexity-comet": "perplexity-comet",
};

const HOSTED: InfraCategory[] = ["cloud_aws", "cloud_azure", "cloud_gcp", "cloud_other", "hosting_vps"];

const PRIOR = -1.2;
/** Signals that point at an AI agent specifically, not just automation. */
const AI_SPECIFIC = new Set(["ai_operator_ip", "unverifiable_claim", "ai_app_user_agent", "agent_like_dom", "instant_checkout"]);
/** Browser-group signals that actually mean "no browser ran" (scripts), so not a driven browser. */
const SCRIPT_ONLY = new Set(["no_javascript", "no_subresources"]);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const sum = (xs: Array<number | undefined>) => xs.reduce<number>((a, b) => a + (Number(b) || 0), 0);

export function bucketFor(p: number): AgentBucket {
  if (p >= 0.9) return "ai_agent";
  if (p >= 0.7) return "probably_ai_agent";
  if (p >= 0.35) return "not_sure";
  return "not_ai_agent";
}

export function scoreVisit(v: VisitEvidence): AgentScore {
  const reasons: ScoreReason[] = [];
  const add = (signal: string, group: ScoreReason["group"], weight: number, text: string) => reasons.push({ signal, group, weight, text });
  const reqs = v.requests;
  const verdicts = new Set(reqs.map((r) => r.verdict));
  const infra = classifyOrigin(v.asn, v.organization);
  const hosted = HOSTED.includes(infra.category);
  const fps = v.client.fingerprints;
  const bs = latestPerPage(v.client.behaviors);
  const checks = consistencyChecks({
    fingerprints: fps,
    headerUserAgents: [...new Set(reqs.map((r) => r.userAgent).filter((x): x is string => Boolean(x)))],
    acceptLanguages: [...new Set(reqs.map((r) => r.acceptLanguage).filter((x): x is string => Boolean(x)))],
    ipCountry: v.country ?? null,
    viaProxy: infra.category === "cdn_proxy" || reqs.some((r) => r.tor),
  });
  const env = environmentFacts(fps);
  const input = inputFacts(bs);
  const extras = { checks, environment: env, input };

  // ---------------------------------------------------------------- proof
  const verified = reqs.find((r) => r.verdict === "verified" && r.agent);
  if (verified) {
    const type = AGENT_KIND[verified.agent!] ?? "ai_crawler";
    const isAi = type !== "search_crawler";
    add("verified_identity", "proof", isAi ? 9 : -9, `${verified.verdictReasons[0] ?? `verified ${verified.agent}`}${isAi ? "" : " — a search crawler, not an AI agent"}`);
    return finish(isAi ? 0.99 : 0.02, type, verified.agent, true, reasons, extras);
  }
  const artifacts = [...fps, ...bs].flatMap((d) => (Array.isArray(d.artifacts) ? d.artifacts : []));
  const known = artifacts.find((a: any) => a?.known);
  if (known) {
    const agent = KNOWN_ARTIFACT_AGENT[known.known] ?? known.known;
    add("agent_dom_marker", "proof", 9, `the page contained #${known.id}, injected by ${agent} while it controlled the browser`);
    return finish(0.98, "in_browser_agent", agent, true, reasons, extras);
  }

  // ---------------------------------------------------------------- request / network
  let type: AgentType | null = null;
  let agent: string | null = null;
  const spoofed = reqs.filter((r) => r.verdict === "spoofed");
  const probing = reqs.filter((r) => r.probing).length;
  if (spoofed.length) {
    add("spoofed_identity", "request", -2.5, `${spoofed[0]!.verdictReasons[0]} — a fake AI/bot identity is a scanner's disguise, not an AI agent`);
    type = "scanner";
  }
  if (probing >= 2) {
    add("probing", "journey", -1.5, `${probing} requests for secrets/admin/config paths (.env, wp-config, .git…) — scanner behaviour`);
    type ??= "scanner";
  }
  const agentIp = reqs.find((r) => r.verdict === "agent_ip" && r.agent);
  if (agentIp) {
    add("ai_operator_ip", "network", 3.5, `no bot user-agent, but the IP is inside ${agentIp.agent}.json (an AI operator's published agent range)`);
    type ??= AGENT_KIND[agentIp.agent!] ?? "cloud_browser_agent";
    agent ??= agentIp.agent;
  }
  const claimed = reqs.find((r) => r.verdict === "claimed" && r.agent);
  if (claimed && !spoofed.length) {
    const t = AGENT_KIND[claimed.agent!] ?? "ai_crawler";
    const isAi = t !== "search_crawler";
    add("unverifiable_claim", "request", isAi ? 2.2 : -1, `user-agent claims ${claimed.agent}; its operator publishes no way to verify it`);
    type ??= t;
    agent ??= claimed.agent;
  }
  const aiApp = reqs.find((r) => r.aiApp);
  if (aiApp) {
    add("ai_app_user_agent", "request", 0.8, `user-agent announces the ${aiApp.aiApp} app (a person using an AI app, or its link preview)`);
    type ??= "ai_app";
    agent ??= aiApp.aiApp;
  }
  const lib = reqs.find((r) => r.uaLibrary);
  if (lib) {
    const headless = lib.uaLibrary === "headless-chrome";
    const w = headless ? 1.8 : probing ? 0.2 : 1.0;
    add("automation_client", "request", w, headless ? "user-agent says HeadlessChrome (browser automation)" : `user-agent is the ${lib.uaLibrary} HTTP client — scripts, scanners and many AI agents' fetch tools`);
    type ??= headless ? "browser_automation" : "script";
  }
  if (verdicts.has("automation") && !lib && reqs.some((r) => !r.browserFamily)) {
    add("non_browser_client", "request", 0.6, "non-browser client with no user-agent token we recognise");
    type ??= "script";
  }
  const flags = [...new Set(reqs.flatMap((r) => r.consistencyFlags))];
  if (flags.length) {
    const tlsFlags = flags.filter((f) => f.startsWith("tls_") || f.startsWith("h2_"));
    const hdrFlags = flags.filter((f) => !tlsFlags.includes(f));
    if (tlsFlags.length) add("tls_mismatch", "network", 1.8, `browser user-agent, but the TLS/HTTP2 handshake isn't that browser's (${tlsFlags.join(", ")})`);
    if (hdrFlags.length) add("header_mismatch", "request", Math.min(2, 0.6 * hdrFlags.length), `headers a real browser would send are missing or inconsistent (${hdrFlags.join(", ")})`);
    // A TLS stack that isn't the claimed browser's means a script wearing a browser user-agent;
    // header gaps alone can still be a real (automated) browser.
    type ??= tlsFlags.length ? "script" : "browser_automation";
  }
  if (infra.category !== "unknown" && infra.category !== "unclassified") {
    if (hosted) add("datacenter_ip", "network", reqs.some((r) => r.browserFamily) ? 1.0 : 0.4, `connects from ${infra.label} — a data centre, where cloud agents run (people browse from home or mobile networks)`);
    // A home network says "a person" only for a browser — scripts and local agent tools run from home too.
    else if (infra.category === "residential_mobile" && reqs.some((r) => r.browserFamily)) add("residential_ip", "network", -0.7, `connects from a residential/mobile network (${v.organization ?? infra.label})`);
    else if (infra.category === "cdn_proxy") add("proxy_ip", "network", 0.3, `connects through ${infra.label} (VPN/proxy edge)`);
  }
  if (reqs.some((r) => r.tor)) add("tor", "network", 0.3, "Tor exit node");

  // ---------------------------------------------------------------- browser (in-page collector)
  const htmlPages = reqs.filter((r) => r.isHtmlPage).length;
  if (htmlPages >= 2 && fps.length === 0 && !lib) {
    add("no_javascript", "browser", 1.2, `${htmlPages} pages loaded but our page script never reported — no JavaScript ran (a fetcher/script, not a browser)`);
    type ??= "script";
  }
  if (htmlPages >= 1 && fps.length === 0 && reqs.some((r) => r.browserFamily) && !reqs.some((r) => r.isAsset)) {
    add("no_subresources", "browser", 0.8, "browser user-agent, but no CSS/JS/images were fetched — the page was read, not rendered");
  }
  // Every page load counts, not just the first: an automation tell on any page is a tell.
  if (fps.length) {
    const any = (pred: (f: Record<string, any>) => unknown) => fps.find((f) => { try { return Boolean(pred(f)); } catch { return false; } });
    const globalsFp = any((f) => Array.isArray(f.automation?.globals) && f.automation.globals.length);
    if (any((f) => f.nav?.webdriver === true)) add("webdriver", "browser", 2.5, "navigator.webdriver is true — the browser is under automation control");
    if (globalsFp) add("automation_globals", "browser", 2.5, `automation framework globals present: ${globalsFp.automation.globals.join(", ")}`);
    if (any((f) => f.automation?.webdriverGetterNative === false || f.automation?.webdriverOwnProp === true)) add("webdriver_tampered", "browser", 2.0, "navigator.webdriver was patched — a stealth plugin hiding automation");
    if (any((f) => f.automation?.cdpRuntime === true)) add("cdp_attached", "browser", 1.5, "a DevTools-protocol client is attached to the page (Puppeteer/Playwright/extension debugger)");
    const softGpu = any((f) => /swiftshader|llvmpipe|software/i.test(String(f.webgl?.renderer ?? "")));
    if (any((f) => f.webgl && f.webgl.supported === false)) add("no_webgl", "browser", 1.2, "no WebGL — typical of headless/server browsers");
    else if (softGpu) add("software_gpu", "browser", 1.5, `software GPU renderer (${softGpu.webgl.renderer}) — a browser running on a server`);
    if (any((f) => f.screen?.outerW === 0 && f.screen?.outerH === 0)) add("zero_outer_window", "browser", 0.6, "window has no outer size (hidden, minimised or headless window)");
    const injected = any((f) => Array.isArray(f.globalsDiff) && f.globalsDiff.length > 3);
    if (injected) add("injected_globals", "browser", 0.6, `${injected.globalsDiff.length} scripts' globals injected into the page (extensions/agents): ${injected.globalsDiff.slice(0, 5).join(", ")}`);

    // ---- Phase 0: server vs. page consistency
    const bad = (id: ConsistencyCheck["id"]) => checks.find((c) => c.id === id && c.status === "mismatch");
    const uaBad = bad("user_agent");
    if (uaBad) add("ua_mismatch", "browser", 1.5, "the user-agent the page reports differs from the request header's — one of them was rewritten (spoofing extension or agent framework)");
    const osBad = bad("os");
    if (osBad) add("os_mismatch", "browser", 1.6, `the user-agent claims ${osBad.server} but navigator.platform is "${osBad.page}" — a disguised user-agent, typical of cloud browsers`);
    const chBad = bad("client_hints_platform");
    if (chBad && !osBad) add("client_hints_mismatch", "browser", 1.2, `client hints say "${chBad.page}" but the user-agent says ${chBad.server}`);
    const langBad = bad("language");
    if (langBad) add("language_mismatch", "browser", 0.9, `browser language ${langBad.page} vs. Accept-Language "${langBad.server}" — patched in one place only`);
    const tzBad = bad("timezone_country");
    if (tzBad) add("timezone_mismatch", "network", 0.7, `browser timezone ${tzBad.page} doesn't fit the IP's country (${tzBad.server}) — a remote/cloud browser or a proxy`);
    const desktop = fps.some((f) => !/Mobile|Android|iPhone|iPad/.test(String(f.nav?.ua ?? "")));
    if (env.utcTimezone && desktop) add("utc_timezone", "browser", 1.0, "browser clock is set to UTC — the default on servers and cloud browsers; people's devices use a local zone");
    const fpBad = bad("fingerprint_stable");
    if (fpBad) add("fingerprint_changed", "browser", 1.0, `the device fingerprint changed within one visit (${fpBad.page}) — randomised or rotating browser profiles`);
    if (env.tells.length >= 2) add("vm_environment", "browser", Math.min(1.5, 0.9 + 0.3 * (env.tells.length - 2)), `looks like a virtual machine or server: ${env.tells.join(", ")}`);
  }
  const unknownArtifacts = artifacts.filter((a: any) => !a?.known);
  if (unknownArtifacts.length) add("agent_like_dom", "browser", 1.5, `page elements injected with agent-like names: ${unknownArtifacts.slice(0, 3).map((a: any) => `${a.tag}#${a.id || a.cls}`).join(", ")}`);

  // ---------------------------------------------------------------- behavior
  if (bs.length) {
    const b = (k: string) => sum(bs.map((x) => x.behavior?.[k]));
    const clicks = bs.flatMap((x) => (Array.isArray(x.behavior?.clicks) ? x.behavior.clicks : []));
    const moves = b("mouseMoves");
    const keys = b("keyDowns");
    const inputNoKey = b("inputWithoutKey");
    const scrolls = b("scrolls");
    const wheels = b("wheels");
    const touches = b("touches");
    const hiddenDriven = bs.some((x) => x.visibility === "hidden" && x.focus === false) && clicks.length + keys + inputNoKey > 0
      || fps.some((f) => f.doc?.visibility === "hidden" && f.doc?.hasFocus === false);
    if (hiddenDriven) add("driven_while_hidden", "behavior", 2.0, "the page was operated while its tab was hidden and unfocused — nobody was looking at it");
    if (clicks.length) {
      const teleport = clicks.filter((c: any) => (c.movesLast1s ?? 0) <= 1).length;
      const untrusted = clicks.filter((c: any) => c.trusted === false).length;
      const noMouseDown = clicks.filter((c: any) => c.hadMouseDown === false).length;
      if (untrusted) add("synthetic_clicks", "behavior", 2.5, `${untrusted} click(s) were created by script (isTrusted=false)`);
      if (noMouseDown) add("click_without_press", "behavior", 1.2, `${noMouseDown} click(s) without a mouse press — element.click() style`);
      if (teleport === clicks.length && moves <= clicks.length * 2) add("cursor_teleport", "behavior", 1.6, `cursor jumped straight onto ${clicks.length} click target(s) (≤1 mouse move before each) — no human mouse path`);
    }
    // ---- Phase 0: click placement and typing corrections
    if (input.trustedClicks >= 3 && input.clickSpread !== null) {
      const placed = input.centredClicks;
      if (placed >= 3 && placed / Math.max(1, input.trustedClicks) >= 0.8) add("centred_clicks", "behavior", 1.4, `${placed} of ${input.trustedClicks} clicks hit the exact centre of their target — coordinates computed from the element's box, not aimed by hand`);
      else if (input.clickSpread >= 0.12) add("human_click_spread", "behavior", -0.6, "click positions spread naturally across their targets");
    }
    if (input.printableKeys >= 25 && input.correctionKeys === 0 && input.modifierKeys === 0) add("no_typing_corrections", "behavior", 0.6, `${input.printableKeys} characters typed without a single correction, Shift or arrow key`);
    else if (input.printableKeys >= 10 && input.correctionKeys >= 2) add("typing_corrections", "behavior", -0.5, `typing included ${input.correctionKeys} corrections/navigation keys — a person fixing what they typed`);
    if (input.pastes >= 2 && input.keyDowns === 0) add("paste_only_input", "behavior", 0.7, `${input.pastes} pastes and no key presses — fields filled by pasting`);
    if (inputNoKey > 0) add("text_without_keys", "behavior", 1.6, `${inputNoKey} text input(s) arrived without key presses — inserted programmatically`);
    const intervals = bs.flatMap((x) => (Array.isArray(x.behavior?.keyIntervals) ? x.behavior.keyIntervals : []));
    if (intervals.length >= 8) {
      const mean = intervals.reduce((a: number, c: number) => a + c, 0) / intervals.length;
      const sd = Math.sqrt(intervals.reduce((a: number, c: number) => a + (c - mean) ** 2, 0) / intervals.length);
      if (sd < 12) add("robotic_typing", "behavior", 1.5, `typing rhythm is machine-regular (±${sd.toFixed(0)} ms between keys)`);
      else if (sd > 40) add("human_typing", "behavior", -1.0, `irregular, human typing rhythm (±${sd.toFixed(0)} ms)`);
    }
    if (moves > 40 && b("mouseDistance") > 1500) add("human_mouse", "behavior", -1.5, `${moves} mouse movements over ${Math.round(b("mouseDistance"))} px — a continuous human mouse path`);
    if (wheels > 2) add("wheel_scrolling", "behavior", -0.5, "scrolled with a wheel/trackpad");
    if (touches > 0) add("touch", "behavior", -0.8, "touch input");
    if (scrolls === 0 && htmlPages >= 3 && (clicks.length > 0 || keys > 0)) add("no_scroll", "behavior", 0.5, "interacted with several pages without ever scrolling");
  }

  // ---------------------------------------------------------------- journey
  const pageTimes = reqs.filter((r) => r.isHtmlPage).map((r) => Date.parse(r.at)).sort((a, b) => a - b);
  const gaps = pageTimes.slice(1).map((t, i) => t - pageTimes[i]!);
  const mg = median(gaps);
  if (mg !== null && pageTimes.length >= 3 && mg < 1500) add("fast_navigation", "journey", 1.0, `moved between pages every ${(mg / 1000).toFixed(1)} s (median) — faster than reading`);
  if (v.shopEvents.includes("SHOP_ORDER_PLACED") && pageTimes.length >= 2) {
    const span = (pageTimes[pageTimes.length - 1]! - pageTimes[0]!) / 1000;
    if (span < 30) add("instant_checkout", "journey", 1.2, `completed browse → basket → checkout → order in ${span.toFixed(0)} s`);
  }

  // ---------------------------------------------------------------- type when nothing decided it
  if (!type) {
    const automated = reasons.filter((r) => r.weight > 0 && ["browser", "behavior"].includes(r.group)).length > 0;
    if (automated) type = hosted ? "cloud_browser_agent" : "in_browser_agent";
    else type = "human";
  } else if (type === "browser_automation" && fps.length) {
    type = hosted ? "cloud_browser_agent" : "browser_automation";
  }

  const logit = PRIOR + reasons.reduce((s, r) => s + r.weight, 0);
  let p = sigmoid(logit);
  // A scanner wearing an AI name is automated but is not an AI agent — cap it.
  if (type === "scanner") p = Math.min(p, 0.2);
  // "Automated" is not "AI agent". Without AI-specific evidence, or a real browser that ran our
  // page script and was visibly driven, the most we can honestly say is "not sure, leans agent".
  const aiEvidence = reasons.some((r) => r.weight > 0 && AI_SPECIFIC.has(r.signal));
  const drivenBrowser = reasons.some((r) => r.weight > 0 && (r.group === "browser" || r.group === "behavior") && !SCRIPT_ONLY.has(r.signal));
  if (!aiEvidence && !drivenBrowser) {
    if (p > 0.69) add("no_ai_evidence", "proof", 0, "automated, but nothing ties it to an AI agent rather than an ordinary bot — capped at \"not sure\"");
    p = Math.min(p, 0.69);
  }
  return finish(p, type, agent, false, reasons, extras);
}

/**
 * Behaviour beacons are cumulative snapshots of one page load (sent every 15 s and on hide), so
 * summing them double-counts. Keep the latest snapshot per page load (`pl`); beacons without a
 * page-load id (older data) are kept as they are.
 */
export function latestPerPage(bs: Array<Record<string, any>>): Array<Record<string, any>> {
  const byPl = new Map<string, Record<string, any>>();
  const loose: Array<Record<string, any>> = [];
  for (const b of bs) {
    if (typeof b.pl !== "string" || !b.pl) { loose.push(b); continue; }
    const cur = byPl.get(b.pl);
    if (!cur || (Number(b.clientT) || 0) >= (Number(cur.clientT) || 0)) byPl.set(b.pl, b);
  }
  return [...loose, ...byPl.values()];
}

function finish(p: number, type: AgentType, agent: string | null, proven: boolean, reasons: ScoreReason[], extras: Pick<AgentScore, "checks" | "environment" | "input">): AgentScore {
  const probability = Math.round(p * 1000) / 1000;
  reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return {
    probability,
    bucket: bucketFor(probability),
    type,
    agent,
    proven,
    leaning: probability >= 0.5 ? "agent" : "human",
    reasons,
    calibrated: false,
    ...extras,
  };
}
