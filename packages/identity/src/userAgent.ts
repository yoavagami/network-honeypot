import { AGENTS, AI_APP_PATTERNS, LIBRARY_PATTERNS, type AgentDef } from "./agents.js";

export interface UaInfo {
  /** Bot/agent identity the user-agent claims, if any (a claim, not a fact). */
  claim: AgentDef | null;
  /** AI assistant app or browser announcing itself (Claude desktop, Atlas favicon fetch, ...). */
  aiApp: string | null;
  /** HTTP library / automation tool announcing itself. */
  library: string | null;
  browser: { family: string; major: number | null; chromium: boolean } | null;
  platform: string | null;
}

export function parseUserAgent(ua: string | null | undefined): UaInfo {
  const s = ua ?? "";
  const lower = s.toLowerCase();
  const trimmed = s.trim();
  const claim = AGENTS.find((a) => a.uaTokens.some((t) => lower.includes(t.toLowerCase())) || a.uaExact?.includes(trimmed)) ?? null;
  const aiApp = AI_APP_PATTERNS.find((p) => p.re.test(s))?.id ?? null;
  const library = LIBRARY_PATTERNS.find((p) => p.re.test(s))?.id ?? null;
  return { claim, aiApp, library, browser: parseBrowser(s), platform: parsePlatform(s) };
}

function major(re: RegExp, s: string): number | null {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
}

function parseBrowser(s: string): UaInfo["browser"] {
  if (!s.startsWith("Mozilla/")) return null;
  if (/Edg\//.test(s)) return { family: "edge", major: major(/Edg\/(\d+)/, s), chromium: true };
  if (/OPR\//.test(s)) return { family: "opera", major: major(/OPR\/(\d+)/, s), chromium: true };
  if (/HeadlessChrome\//.test(s)) return { family: "headless-chrome", major: major(/HeadlessChrome\/(\d+)/, s), chromium: true };
  if (/CriOS\//.test(s)) return { family: "chrome-ios", major: major(/CriOS\/(\d+)/, s), chromium: false };
  if (/FxiOS\//.test(s)) return { family: "firefox-ios", major: major(/FxiOS\/(\d+)/, s), chromium: false };
  if (/Firefox\//.test(s)) return { family: "firefox", major: major(/Firefox\/(\d+)/, s), chromium: false };
  if (/Chrome\//.test(s)) return { family: "chrome", major: major(/Chrome\/(\d+)/, s), chromium: true };
  if (/Version\/[\d.]+.*Safari\//.test(s)) return { family: "safari", major: major(/Version\/(\d+)/, s), chromium: false };
  return { family: "other", major: null, chromium: false };
}

function parsePlatform(s: string): string | null {
  if (/Windows NT/.test(s)) return "Windows";
  if (/Android/.test(s)) return "Android";
  if (/iPhone|iPad|iPod/.test(s)) return "iOS";
  if (/CrOS/.test(s)) return "Chrome OS";
  if (/Mac OS X|Macintosh/.test(s)) return "macOS";
  if (/Linux/.test(s)) return "Linux";
  return null;
}
