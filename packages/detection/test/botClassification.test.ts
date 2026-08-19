import { describe, it, expect } from "vitest";
import { classifyBot } from "../src/botClassification.js";

describe("classifyBot", () => {
  it("identifies a known search crawler with high confidence", () => {
    const result = classifyBot({
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      followedRobotsThenSitemapThenDocs: false,
      systematicSequentialNavigation: false,
      scannerDetectionConfidence: null,
    });
    expect(result.label).toBe("search_crawler");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("labels AI crawler UAs distinctly from generic bots", () => {
    const result = classifyBot({
      userAgent: "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)",
      followedRobotsThenSitemapThenDocs: false,
      systematicSequentialNavigation: false,
      scannerDetectionConfidence: null,
    });
    expect(result.label).toBe("ai_llm_agent");
  });

  it("never claims certainty — confidence is always < 1 without a definitive signal", () => {
    const result = classifyBot({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0",
      followedRobotsThenSitemapThenDocs: false,
      systematicSequentialNavigation: false,
      scannerDetectionConfidence: null,
    });
    expect(result.label).toBe("likely_human");
    expect(result.confidence).toBeLessThan(1);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("hedges browser-automation detection as possible, not certain", () => {
    const result = classifyBot({
      userAgent: "Mozilla/5.0 HeadlessChrome/128.0",
      followedRobotsThenSitemapThenDocs: true,
      systematicSequentialNavigation: true,
      scannerDetectionConfidence: null,
    });
    expect(result.label).toBe("browser_automation");
    expect(result.confidence).toBeLessThan(1);
    expect(result.signals).toContain("systematic-sequential-navigation");
  });
});
