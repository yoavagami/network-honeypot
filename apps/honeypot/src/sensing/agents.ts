/**
 * Known AI agents / bots and what *proves* each identity. Mirrors the agent-traffic-classifier's
 * registry/agents.yaml (sources: OpenAI, Anthropic, Google, Perplexity, Bing bot docs, checked
 * October 2026). A user-agent claim is only ever a claim — `ranges`, `rdnsSuffixes` and
 * `signers` are what turn it into "verified", and a claim that contradicts them is "spoofed".
 */
export interface AgentDef {
  id: string;
  operator: string;
  kind: "crawler" | "user_initiated";
  /** Case-insensitive user-agent substrings that claim this identity. */
  uaTokens: string[];
  /** Whole user-agent strings that claim it (for agents whose user-agent is a bare word). */
  uaExact?: string[];
  /** Runs on the user's own computer, so it comes from their IP and can't be verified. */
  local?: boolean;
  /** Files in data/ranges/ with the operator's published IPs for this agent. */
  ranges?: string[];
  /** Reverse-DNS suffixes the operator documents (forward-confirmed). */
  rdnsSuffixes?: string[];
  /** Web Bot Auth signer origins (Signature-Agent) for this agent. */
  signers?: string[];
}

export const AGENTS: AgentDef[] = [
  // OpenAI
  { id: "gptbot", operator: "OpenAI", kind: "crawler", uaTokens: ["GPTBot"], ranges: ["openai-gptbot"] },
  { id: "oai-searchbot", operator: "OpenAI", kind: "crawler", uaTokens: ["OAI-SearchBot"], ranges: ["openai-searchbot"] },
  { id: "chatgpt-user", operator: "OpenAI", kind: "user_initiated", uaTokens: ["ChatGPT-User"], ranges: ["openai-chatgpt-user"] },
  { id: "oai-adsbot", operator: "OpenAI", kind: "crawler", uaTokens: ["OAI-AdsBot"], ranges: ["openai-adsbot"] },
  // Cloud browser: Chrome user-agent, identified only by its signature.
  { id: "chatgpt-agent", operator: "OpenAI", kind: "user_initiated", uaTokens: [], signers: ["https://chatgpt.com"] },
  // Anthropic
  { id: "claudebot", operator: "Anthropic", kind: "crawler", uaTokens: ["ClaudeBot", "Claude-Web", "anthropic-ai"], ranges: ["anthropic-bots"] },
  // Claude Code's WebFetch: "Claude-User (claude-code/2.1.309; ...)" from the user's own machine.
  // Must come before claude-user, whose token it also contains.
  { id: "claude-code", operator: "Anthropic", kind: "user_initiated", uaTokens: ["claude-code/"], local: true },
  // claude.ai's web fetch came from Anthropic's own network (anthropic-egress), not bots.json.
  { id: "claude-user", operator: "Anthropic", kind: "user_initiated", uaTokens: ["Claude-User"], ranges: ["anthropic-bots", "anthropic-egress"] },
  { id: "claude-searchbot", operator: "Anthropic", kind: "crawler", uaTokens: ["Claude-SearchBot"], ranges: ["anthropic-bots"] },
  // Google
  { id: "google-agent", operator: "Google", kind: "user_initiated", uaTokens: ["Google-Agent"], ranges: ["google-user-triggered-agents"], signers: ["https://agent.bot.goog"] },
  // Gemini's "read this page" fetch: user-agent is just "Google", from rate-limited-proxy-*.google.com.
  { id: "google-user-fetch", operator: "Google", kind: "user_initiated", uaTokens: [], uaExact: ["Google"], ranges: ["google-user-triggered-fetchers"], rdnsSuffixes: [".google.com"] },
  { id: "gemini-notebook", operator: "Google", kind: "user_initiated", uaTokens: ["Google-GeminiNotebook", "Google-NotebookLM"], ranges: ["google-user-triggered-fetchers"] },
  { id: "googlebot", operator: "Google", kind: "crawler", uaTokens: ["Googlebot", "Google-InspectionTool", "GoogleOther", "Google-Extended"], ranges: ["google-googlebot"], rdnsSuffixes: [".googlebot.com", ".google.com"] },
  // NOT .googleusercontent.com: every Google Cloud customer VM reverse-resolves there (found live —
  // a scanner on GCP sending Googlebot user-agents was "verified" by it).
  // Perplexity
  { id: "perplexitybot", operator: "Perplexity", kind: "crawler", uaTokens: ["PerplexityBot"], ranges: ["perplexity-perplexitybot"] },
  { id: "perplexity-user", operator: "Perplexity", kind: "user_initiated", uaTokens: ["Perplexity-User"], ranges: ["perplexity-perplexity-user"] },
  // Microsoft / Apple / Amazon (rDNS-verifiable)
  { id: "bingbot", operator: "Microsoft", kind: "crawler", uaTokens: ["bingbot", "BingPreview"], ranges: ["bing-bingbot"], rdnsSuffixes: [".search.msn.com"] },
  { id: "applebot", operator: "Apple", kind: "crawler", uaTokens: ["Applebot"], rdnsSuffixes: [".applebot.apple.com"] },
  { id: "amazonbot", operator: "Amazon", kind: "crawler", uaTokens: ["Amazonbot"], rdnsSuffixes: [".crawl.amazonbot.amazon"] },
  // No published verification — claims stay "claimed".
  { id: "meta-externalagent", operator: "Meta", kind: "crawler", uaTokens: ["meta-externalagent", "meta-webindexer"] },
  { id: "meta-externalfetcher", operator: "Meta", kind: "user_initiated", uaTokens: ["meta-externalfetcher"] },
  { id: "grokbot", operator: "xAI", kind: "crawler", uaTokens: ["GrokBot", "xAI-Bot"] },
  { id: "mistral-user", operator: "Mistral", kind: "user_initiated", uaTokens: ["MistralAI-User"] },
  { id: "duckassistbot", operator: "DuckDuckGo", kind: "user_initiated", uaTokens: ["DuckAssistBot"] },
  { id: "bytespider", operator: "ByteDance", kind: "crawler", uaTokens: ["Bytespider"] },
  { id: "ccbot", operator: "Common Crawl", kind: "crawler", uaTokens: ["CCBot"] },
  { id: "cohere", operator: "Cohere", kind: "crawler", uaTokens: ["cohere-ai", "cohere-training-data-crawler"] },
  { id: "youbot", operator: "You.com", kind: "crawler", uaTokens: ["YouBot"] },
  { id: "qwenbot", operator: "Alibaba", kind: "crawler", uaTokens: ["Qwenbot"] },
  { id: "kimi", operator: "Moonshot", kind: "crawler", uaTokens: ["KimiBot", "Kimi-SearchBot", "MoonshotBot"] },
  { id: "chatglm", operator: "Zhipu", kind: "crawler", uaTokens: ["ChatGLM-Spider"] },
  { id: "bravebot", operator: "Brave", kind: "crawler", uaTokens: ["Bravebot"] },
  { id: "diffbot", operator: "Diffbot", kind: "crawler", uaTokens: ["Diffbot"] },
  { id: "ai2bot", operator: "Allen AI", kind: "crawler", uaTokens: ["AI2Bot"] },
  { id: "petalbot", operator: "Huawei", kind: "crawler", uaTokens: ["PetalBot"] },
];

/** Remote-browser platforms that sign (Web Bot Auth) without saying which assistant drives them. */
export const SIGNING_PLATFORMS: Record<string, string> = {
  "https://browserbase.com": "browserbase",
  "https://anchorbrowser.io": "anchor-browser",
  "https://block.xyz": "goose",
  "https://cloudflare.com": "cloudflare-browser-rendering",
};

/** AI assistant apps / browsers that announce themselves in the user-agent (not bots). */
export const AI_APP_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "claude-desktop", re: /\bClaude\/\d/ },
  { id: "chatgpt-atlas", re: /ChatGPT[ %20]*Atlas/i },
  { id: "chatgpt-app", re: /\bChatGPT\/\d/ },
  { id: "perplexity-app", re: /\bPerplexity\/\d/ },
  { id: "comet", re: /\bComet\/\d/ },
];

/** HTTP client libraries / automation that announce themselves. */
export const LIBRARY_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "python-requests", re: /python-requests/i },
  { id: "python-httpx", re: /python-httpx/i },
  { id: "aiohttp", re: /aiohttp/i },
  { id: "python-urllib", re: /python-urllib|Python-urllib/i },
  { id: "go-http", re: /Go-http-client/i },
  { id: "curl", re: /^curl\//i },
  { id: "wget", re: /^Wget\//i },
  { id: "node", re: /node-fetch|undici|axios|^node\b/i },
  { id: "okhttp", re: /okhttp/i },
  { id: "java", re: /^Java\/|Apache-HttpClient/i },
  { id: "headless-chrome", re: /HeadlessChrome/ },
  { id: "phantomjs", re: /PhantomJS/i },
  { id: "scrapy", re: /Scrapy/i },
  { id: "libwww", re: /libwww-perl|LWP::/i },
];
