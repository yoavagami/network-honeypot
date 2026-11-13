import { describe, it, expect } from "vitest";
import { parseLabValue, signLabToken } from "../src/labToken.js";

const SECRET = "test-secret-0123456789";
const now = Date.parse("2026-11-13T10:00:00Z");
const in1h = Math.floor(now / 1000) + 3600;

describe("signed lab links", () => {
  it("verifies a token it minted", () => {
    const t = signLabToken("claude-chrome-checkout-1", in1h, SECRET);
    expect(parseLabValue(t, SECRET, now)).toEqual({ label: "claude-chrome-checkout-1", verified: true, expiresAt: in1h });
  });

  it("downgrades a bare label to claimed", () => {
    expect(parseLabValue("chatgpt-agent-1", SECRET, now)).toEqual({ label: "chatgpt-agent-1", verified: false });
  });

  it("downgrades a forged, tampered or expired token to claimed", () => {
    const t = signLabToken("human-chrome-1", in1h, SECRET);
    expect(parseLabValue(t, "other-secret", now)?.verified).toBe(false);
    expect(parseLabValue(t.replace("human-chrome-1", "human-chrome-2"), SECRET, now)?.verified).toBe(false);
    expect(parseLabValue(t.replace(String(in1h), String(in1h + 999)), SECRET, now)?.verified).toBe(false);
    expect(parseLabValue(t, SECRET, (in1h + 1) * 1000)?.verified).toBe(false);
    // the label part is still kept, as a claim
    expect(parseLabValue(t, "other-secret", now)?.label).toBe("human-chrome-1");
  });

  it("never verifies without a secret", () => {
    const t = signLabToken("human-chrome-1", in1h, SECRET);
    expect(parseLabValue(t, undefined, now)?.verified).toBe(false);
  });

  it("rejects junk", () => {
    expect(parseLabValue("<script>", SECRET, now)).toBeNull();
    expect(parseLabValue("a".repeat(200), SECRET, now)).toBeNull();
    expect(parseLabValue(undefined, SECRET, now)).toBeNull();
    expect(() => signLabToken("bad label", in1h, SECRET)).toThrow();
  });
});
