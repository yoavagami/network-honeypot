/**
 * Signal registry for the visit score (agentScore.ts): every signal the scorer can emit, with its
 * group, default weight, the question it answers and how it interacts with the "no AI evidence"
 * cap. The scorer reads weights from here, so calibration can replace this table per
 * SCORER_VERSION without touching the scoring logic, and the dashboard can list every signal.
 *
 * `weight` is the default log-odds contribution. Signals marked `dynamic` compute their weight
 * from the evidence (e.g. per mismatched header); for those `weight` is the typical value and
 * `dynamic` says how it varies.
 */

/** Bump when weights, signals or scoring logic change; stored with every visit_scores row. */
export const SCORER_VERSION = "2026.11.13-5";

export type SignalGroup = "proof" | "network" | "request" | "browser" | "behavior" | "journey";
/** The three questions a verdict answers (plus the shop journey). */
export type SignalQuestion = "identity" | "driver" | "environment" | "journey";

export interface SignalDef {
  group: SignalGroup;
  weight: number;
  question: SignalQuestion;
  /** Points at an AI agent specifically, not just automation — lifts the "not sure" cap. */
  aiSpecific?: boolean;
  /** Means "no real browser ran" (or isn't trustworthy page evidence) — does not count as a visibly driven browser. */
  scriptOnly?: boolean;
  /** How the weight varies, for signals whose weight depends on the evidence. */
  dynamic?: string;
  summary: string;
}

const def = <T extends Record<string, SignalDef>>(t: T) => t;

export const SIGNALS = def({
  // ---- proof
  verified_identity: { group: "proof", weight: 9, question: "identity", dynamic: "+9 for an AI operator, −9 for a search crawler", summary: "Web Bot Auth signature, operator IP list or forward-confirmed rDNS proves the identity" },
  agent_dom_marker: { group: "proof", weight: 9, question: "identity", summary: "a known agent's own UI element was injected into the page" },
  agent_probe: { group: "proof", weight: 9, question: "identity", summary: "a named-agent probe fired: browser-use's scanner read the decoy field, Manus answered the handshake, or a framework's own globals/CSS were present" },
  no_ai_evidence: { group: "proof", weight: 0, question: "identity", summary: "automated, but nothing ties it to an AI agent — probability capped at 0.69" },

  // ---- request / network identity
  spoofed_identity: { group: "request", weight: -2.5, question: "identity", summary: "claims a bot identity its operator's IP list or signature contradicts (a scanner's disguise)" },
  ai_operator_ip: { group: "network", weight: 3.5, question: "identity", aiSpecific: true, summary: "no bot user-agent, but the IP is in an AI operator's published agent range" },
  unverifiable_claim: { group: "request", weight: 2.2, question: "identity", aiSpecific: true, dynamic: "+2.2 for an AI agent claim, −1 for a search crawler claim", summary: "user-agent claims an AI agent whose operator publishes no way to verify it" },
  ai_app_user_agent: { group: "request", weight: 0.8, question: "identity", aiSpecific: true, summary: "user-agent announces an AI assistant app" },
  automation_client: { group: "request", weight: 1.0, question: "identity", dynamic: "1.8 for HeadlessChrome, 0.2 while probing, else 1.0", summary: "user-agent is an HTTP library or headless browser" },
  non_browser_client: { group: "request", weight: 0.6, question: "identity", summary: "non-browser client with no recognised user-agent token" },

  // ---- environment: connection and headers
  tls_mismatch: { group: "network", weight: 1.8, question: "environment", summary: "browser user-agent, but the TLS/HTTP2 handshake isn't that browser's" },
  header_mismatch: { group: "request", weight: 1.2, question: "environment", dynamic: "0.6 per inconsistent header, max 2", summary: "headers a real browser sends are missing or inconsistent" },
  datacenter_ip: { group: "network", weight: 1.0, question: "environment", dynamic: "1.0 with a browser user-agent, else 0.4", summary: "connects from a data centre or VPS" },
  residential_ip: { group: "network", weight: -0.7, question: "environment", summary: "a browser on a residential or mobile network" },
  proxy_ip: { group: "network", weight: 0.3, question: "environment", summary: "connects through a VPN/proxy edge" },
  tor: { group: "network", weight: 0.3, question: "environment", summary: "Tor exit node" },
  timezone_mismatch: { group: "network", weight: 0.7, question: "environment", summary: "browser timezone doesn't fit the IP's country" },

  // ---- environment: did a browser run at all (rendering ladder and fallbacks)
  html_only: { group: "browser", weight: 1.6, question: "environment", scriptOnly: true, dynamic: "1.6 with a browser user-agent, else 1.0", summary: "page loads fetched as HTML only — no CSS, images or JavaScript" },
  html_parser_images: { group: "browser", weight: 1.2, question: "environment", scriptOnly: true, summary: "fetched images incl. the <noscript> one, but no CSS and no JavaScript — an HTML parser" },
  css_no_js: { group: "browser", weight: 0.8, question: "environment", scriptOnly: true, summary: "rendered CSS but never ran the page script" },
  js_without_css: { group: "browser", weight: 1.2, question: "environment", scriptOnly: true, summary: "ran JavaScript but never fetched the CSS beacon — a DOM emulator or image-blocking automation" },
  no_javascript: { group: "browser", weight: 1.2, question: "environment", scriptOnly: true, summary: "several pages loaded, the page script never reported (pre-ladder data)" },
  no_subresources: { group: "browser", weight: 0.8, question: "environment", scriptOnly: true, summary: "browser user-agent, but no CSS/JS/images fetched (pre-ladder data)" },
  beacon_unbound: { group: "browser", weight: 1.0, question: "environment", scriptOnly: true, summary: "page-script beacons for page loads this visitor was never served — forged or replayed telemetry" },

  // ---- environment: in-page automation and lie checks
  webdriver: { group: "browser", weight: 2.5, question: "environment", summary: "navigator.webdriver is true" },
  automation_globals: { group: "browser", weight: 2.5, question: "environment", summary: "automation framework globals present" },
  webdriver_tampered: { group: "browser", weight: 2.0, question: "environment", summary: "navigator.webdriver was patched (stealth plugin)" },
  cdp_attached: { group: "browser", weight: 1.5, question: "environment", summary: "a DevTools-protocol client is attached" },
  no_webgl: { group: "browser", weight: 1.2, question: "environment", summary: "no WebGL — typical of headless or server browsers" },
  software_gpu: { group: "browser", weight: 1.5, question: "environment", summary: "software GPU renderer (SwiftShader, llvmpipe)" },
  zero_outer_window: { group: "browser", weight: 0.6, question: "environment", summary: "window has no outer size" },
  injected_globals: { group: "browser", weight: 0.6, question: "environment", summary: "more than 3 globals injected into the page (extensions/agents)" },
  ua_mismatch: { group: "browser", weight: 1.5, question: "environment", summary: "page user-agent differs from the request header's" },
  os_mismatch: { group: "browser", weight: 1.6, question: "environment", summary: "user-agent OS vs. navigator.platform disagree" },
  client_hints_mismatch: { group: "browser", weight: 1.2, question: "environment", summary: "client-hints platform vs. user-agent OS disagree" },
  language_mismatch: { group: "browser", weight: 0.9, question: "environment", summary: "navigator.languages vs. Accept-Language disagree" },
  utc_timezone: { group: "browser", weight: 1.0, question: "environment", summary: "desktop browser clock set to UTC" },
  browser_identity_mismatch: { group: "browser", weight: 1.6, question: "environment", summary: "fixed browser traits (vendor, productSub, engine objects) contradict the claimed browser" },
  fingerprint_changed: { group: "browser", weight: 1.0, question: "environment", summary: "device fingerprint changed within one visit" },
  vm_environment: { group: "browser", weight: 0.9, question: "environment", dynamic: "0.9 for 2 tells, +0.3 per extra, max 1.5", summary: "virtual-machine/server tells (cores, memory, PDF viewer)" },
  anonymous_body_overlay: { group: "browser", weight: 0.8, question: "identity", summary: "on most pages an empty, attribute-less element was appended to <body> right after load — a driving tool's overlay container" },
  agent_like_dom: { group: "browser", weight: 1.5, question: "identity", aiSpecific: true, summary: "page elements injected with agent-like names" },

  // ---- driver: is a human operating the input
  driven_while_hidden: { group: "behavior", weight: 2.0, question: "driver", summary: "operated while the tab was hidden and unfocused" },
  synthetic_clicks: { group: "behavior", weight: 2.5, question: "driver", summary: "clicks created by script (isTrusted=false)" },
  click_without_press: { group: "behavior", weight: 1.2, question: "driver", summary: "clicks without a mouse press" },
  cursor_teleport: { group: "behavior", weight: 1.6, question: "driver", summary: "cursor jumped straight onto every click target" },
  centred_clicks: { group: "behavior", weight: 1.4, question: "driver", summary: "clicks land on the exact centre of their targets" },
  human_click_spread: { group: "behavior", weight: -0.6, question: "driver", summary: "click positions spread naturally" },
  think_then_act: { group: "behavior", weight: 1.3, question: "driver", aiSpecific: true, summary: "still-cursor pauses, then a jump onto the target — an agent working from screenshots" },
  no_typing_corrections: { group: "behavior", weight: 0.6, question: "driver", summary: "25+ characters typed with no correction, Shift or arrow key" },
  typing_corrections: { group: "behavior", weight: -0.5, question: "driver", summary: "typing included corrections" },
  paste_only_input: { group: "behavior", weight: 0.7, question: "driver", summary: "fields filled by pasting, no key presses" },
  text_without_keys: { group: "behavior", weight: 1.6, question: "driver", summary: "text input arrived without key presses" },
  robotic_typing: { group: "behavior", weight: 1.5, question: "driver", summary: "machine-regular typing rhythm" },
  human_typing: { group: "behavior", weight: -1.0, question: "driver", summary: "irregular, human typing rhythm" },
  human_mouse: { group: "behavior", weight: -1.5, question: "driver", summary: "continuous human mouse path" },
  wheel_scrolling: { group: "behavior", weight: -0.5, question: "driver", summary: "scrolled with a wheel/trackpad" },
  touch: { group: "behavior", weight: -0.8, question: "driver", summary: "touch input" },
  no_scroll: { group: "behavior", weight: 0.5, question: "driver", summary: "interacted with several pages without scrolling" },
  jump_clicks: { group: "behavior", weight: 1.2, question: "driver", dynamic: "1.2 for 2 jump clicks, 2.0 for 3 or more", summary: "the cursor appeared on the target and clicked within 50 ms, with no mouse path" },
  browser_autofill: { group: "behavior", weight: -0.6, question: "driver", summary: "form fields filled by the browser's autofill — a person's saved details" },
  form_set_by_script: { group: "behavior", weight: 1.8, question: "driver", summary: "form fields filled with no key presses or pastes — values set by script" },
  scroll_without_input: { group: "behavior", weight: 0.8, question: "driver", summary: "scrolled with no wheel, key, touch or mouse — scrolled by script" },

  // ---- journey
  probing: { group: "journey", weight: -1.5, question: "journey", summary: "requests for secrets/admin/config paths — scanner behaviour" },
  fast_navigation: { group: "journey", weight: 1.0, question: "journey", summary: "moved between pages faster than reading" },
  instant_checkout: { group: "journey", weight: 1.2, question: "journey", aiSpecific: true, summary: "browse → basket → checkout → order in under 30 s" },
  // pageControl.ts: who drove each page — informational (weight 0); when an agent drove part of
  // the visit, the person's human-input credit is shown but not counted against the agent's evidence.
  handover_agent_to_human: { group: "journey", weight: 0, question: "driver", summary: "started by an automated agent, then a person took over" },
  handover_human_to_agent: { group: "journey", weight: 0, question: "driver", summary: "a person started, then automation took over" },
  mixed_control: { group: "journey", weight: 0, question: "driver", summary: "pages alternate between automated and human input" },
});

export type SignalId = keyof typeof SIGNALS;

/** Default weight of a signal. */
export const W = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [k, v.weight])) as Record<SignalId, number>;

export const AI_SPECIFIC_SIGNALS: ReadonlySet<string> = new Set(Object.entries(SIGNALS).filter(([, v]) => (v as SignalDef).aiSpecific).map(([k]) => k));
export const SCRIPT_ONLY_SIGNALS: ReadonlySet<string> = new Set(Object.entries(SIGNALS).filter(([, v]) => (v as SignalDef).scriptOnly).map(([k]) => k));

/** The registry as a list, for the dashboard's signal catalogue. */
export function signalCatalogue(): Array<SignalDef & { id: SignalId }> {
  return (Object.entries(SIGNALS) as Array<[SignalId, SignalDef]>).map(([id, d]) => ({ id, ...d }));
}
