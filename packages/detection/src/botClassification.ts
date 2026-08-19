import type { BotClassification, Classification } from "@honeypot/types";
import { matchesAiAgentUa, matchesBrowserAutomationUa, matchesScannerUa, matchesSearchCrawlerUa } from "./rules/inline/scannerUa.js";

export interface BotClassificationInput {
  userAgent: string | null;
  followedRobotsThenSitemapThenDocs: boolean;
  systematicSequentialNavigation: boolean;
  scannerDetectionConfidence: number | null;
}

/**
 * See docs/DETECTION.md §5. Every result carries confidence + signals — never presented as
 * unqualified fact, especially "possible AI-assisted automation" per the brief's §21.
 */
export function classifyBot(input: BotClassificationInput): Classification & { label: BotClassification } {
  const signals: string[] = [];

  if (matchesSearchCrawlerUa(input.userAgent)) {
    signals.push("known-search-crawler-user-agent");
    return { label: "search_crawler", confidence: 0.9, signals };
  }

  if (matchesAiAgentUa(input.userAgent)) {
    signals.push("known-ai-crawler-user-agent");
    return { label: "ai_llm_agent", confidence: 0.85, signals };
  }

  if (input.scannerDetectionConfidence !== null && input.scannerDetectionConfidence >= 0.6) {
    signals.push(`scanner-detection-confidence:${input.scannerDetectionConfidence.toFixed(2)}`);
    return { label: "security_scanner", confidence: input.scannerDetectionConfidence, signals };
  }

  if (matchesBrowserAutomationUa(input.userAgent)) {
    signals.push("browser-automation-marker-in-user-agent");
    let confidence = 0.6;
    if (input.systematicSequentialNavigation) {
      signals.push("systematic-sequential-navigation");
      confidence += 0.15;
    }
    if (input.followedRobotsThenSitemapThenDocs) {
      signals.push("methodical-discovery-path-robots-sitemap-docs");
      confidence += 0.1;
    }
    return { label: "browser_automation", confidence: Math.min(1, confidence), signals };
  }

  if (matchesScannerUa(input.userAgent)) {
    signals.push("http-library-user-agent");
    return { label: "script_http_library", confidence: 0.75, signals };
  }

  if (input.systematicSequentialNavigation && input.followedRobotsThenSitemapThenDocs) {
    signals.push("methodical-discovery-path", "systematic-sequential-navigation");
    return { label: "unknown_automation", confidence: 0.5, signals };
  }

  if (!input.userAgent) {
    signals.push("missing-user-agent");
    return { label: "unknown_automation", confidence: 0.4, signals };
  }

  signals.push("no-automation-signals-observed");
  return { label: "likely_human", confidence: 0.55, signals };
}
