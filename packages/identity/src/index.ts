/**
 * Request identity checks shared by the honeypot (apps/honeypot) and the merchant service
 * (apps/merchant-api): user-agent claims, Web Bot Auth signatures, operators' published agent IP
 * ranges (bundled in data/ranges/, refreshed at runtime), Tor exits, reverse DNS, and the
 * verified / claimed / spoofed verdict built from them.
 */
export * from "./agents.js";
export * from "./userAgent.js";
export * from "./webBotAuth.js";
export * from "./ipIntel.js";
export * from "./verdict.js";
