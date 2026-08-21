import { describe, it, expect } from "vitest";
import { resolveClientIp } from "../src/fingerprint.js";

describe("resolveClientIp", () => {
  it("ignores CF-Connecting-IP entirely when not explicitly trusted — the default, safe case", () => {
    // This is the security-critical property: without trustCfConnectingIp=true, a client on a
    // non-Cloudflare deployment (VPS/AWS) could set this header to anything, and it must never
    // be believed.
    expect(resolveClientIp("203.0.113.9", "198.51.100.1", false)).toBe("203.0.113.9");
  });

  it("uses CF-Connecting-IP when trusted and present", () => {
    expect(resolveClientIp("104.23.170.41", "198.51.100.1", true)).toBe("198.51.100.1");
  });

  it("falls back to the Fastify-resolved IP when trusted but the header is absent", () => {
    expect(resolveClientIp("203.0.113.9", undefined, true)).toBe("203.0.113.9");
  });

  it("falls back when the header value doesn't look like an IP", () => {
    expect(resolveClientIp("203.0.113.9", "not-an-ip; DROP TABLE actors", true)).toBe("203.0.113.9");
  });

  it("takes the first value when the header arrives as an array", () => {
    expect(resolveClientIp("203.0.113.9", ["198.51.100.1", "198.51.100.2"], true)).toBe("198.51.100.1");
  });

  it("accepts IPv6 addresses", () => {
    expect(resolveClientIp("203.0.113.9", "2001:db8::1", true)).toBe("2001:db8::1");
  });
});
