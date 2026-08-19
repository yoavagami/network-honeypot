import { describe, it, expect } from "vitest";
import { bodyShape, passwordShape, redactCookies, redactHeaders } from "../src/redact.js";

describe("passwordShape", () => {
  it("never returns the actual password, only shape metadata", () => {
    const shape = passwordShape("Sup3r$ecret!");
    expect(JSON.stringify(shape)).not.toContain("Sup3r$ecret!");
    expect(shape.hasDigit).toBe(true);
    expect(shape.hasSymbol).toBe(true);
    expect(shape.hasUpper).toBe(true);
    expect(shape.lengthBucket).toBe("12-15");
  });
});

describe("bodyShape", () => {
  it("retains key names and types but drops password values to a presence flag", () => {
    const shape = bodyShape({ username: "alice", password: "hunter2", remember: true });
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain("hunter2");
    const passwordKey = shape.keys.find((k) => k.name === "password");
    expect(passwordKey?.lengthBucket).toBe("present");
    const usernameKey = shape.keys.find((k) => k.name === "username");
    expect(usernameKey?.type).toBe("string");
  });

  it("handles non-object bodies gracefully", () => {
    expect(bodyShape(null).keys).toEqual([]);
    expect(bodyShape([1, 2, 3]).keys).toEqual([]);
  });
});

describe("redactHeaders", () => {
  it("keeps allowlisted headers verbatim and never returns cookie/authorization", () => {
    const { allowed, unusualNames, headerCount } = redactHeaders({
      "user-agent": "curl/8.0",
      cookie: "session=super-secret-value",
      authorization: "Bearer top-secret-token",
      "x-custom-weird-header": "value",
    });
    expect(allowed["user-agent"]).toBe("curl/8.0");
    expect(allowed.cookie).toBeUndefined();
    expect(allowed.authorization).toBeUndefined();
    expect(JSON.stringify({ allowed, unusualNames })).not.toContain("super-secret-value");
    expect(JSON.stringify({ allowed, unusualNames })).not.toContain("top-secret-token");
    expect(unusualNames).toContain("x-custom-weird-header");
    expect(headerCount).toBe(4);
  });

  it("caps unusual header name capture at 10", () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 20; i++) headers[`x-weird-${i}`] = "v";
    const { unusualNames } = redactHeaders(headers);
    expect(unusualNames.length).toBe(10);
  });
});

describe("redactCookies", () => {
  it("returns only names and count, never values", () => {
    const result = redactCookies({ hp_session: "opaque-id", tracking: "abc123" });
    expect(result.names).toEqual(["hp_session", "tracking"]);
    expect(result.count).toBe(2);
    expect(result.hasSessionCookie).toBe(true);
    expect(JSON.stringify(result)).not.toContain("opaque-id");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });
});
