/**
 * Known scanner/HTTP-library User-Agent substrings. Presence is a *signal*, contributing to
 * Tier 2 scanner classification — never alone treated as proof. See docs/DETECTION.md §2, §4.
 */
const SCANNER_UA_SUBSTRINGS = [
  "curl/",
  "python-requests",
  "python-urllib",
  "go-http-client",
  "nikto",
  "sqlmap",
  "nuclei",
  "nmap",
  "wget/",
  "masscan",
  "zgrab",
  "shodan",
  "censys",
  "libwww-perl",
  "java/",
  "okhttp",
  "axios/",
  "node-fetch",
  "postmanruntime",
  "burpsuite",
  "zaproxy",
  "gobuster",
  "ffuf",
  "dirbuster",
  "httpx",
];

export function matchesScannerUa(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return SCANNER_UA_SUBSTRINGS.some((s) => lower.includes(s));
}

const AI_AGENT_UA_SUBSTRINGS = ["gptbot", "claudebot", "ccbot", "anthropic-ai", "perplexitybot", "google-extended"];
export function matchesAiAgentUa(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return AI_AGENT_UA_SUBSTRINGS.some((s) => lower.includes(s));
}

const BROWSER_AUTOMATION_UA_SUBSTRINGS = ["headlesschrome", "playwright", "puppeteer", "selenium", "phantomjs"];
export function matchesBrowserAutomationUa(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return BROWSER_AUTOMATION_UA_SUBSTRINGS.some((s) => lower.includes(s));
}

const SEARCH_CRAWLER_UA_SUBSTRINGS = ["googlebot", "bingbot", "duckduckbot", "baiduspider", "yandexbot", "applebot"];
export function matchesSearchCrawlerUa(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return SEARCH_CRAWLER_UA_SUBSTRINGS.some((s) => lower.includes(s));
}
