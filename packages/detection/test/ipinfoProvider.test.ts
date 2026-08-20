import { describe, it, expect, vi, afterEach } from "vitest";
import { createIpinfoProvider } from "../src/providers/ipinfo.js";

describe("createIpinfoProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses ASN and organization out of ipinfo's combined 'org' field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ country: "US", region: "California", city: "Mountain View", org: "AS15169 Google LLC", loc: "37.4056,-122.0775" }),
      })
    );

    const provider = createIpinfoProvider("test-token");
    const result = await provider.lookup("8.8.8.8");

    expect(result).toEqual({
      country: "US",
      region: "California",
      city: "Mountain View",
      asn: "AS15169",
      organization: "Google LLC",
      isHostingProvider: null,
      lat: 37.4056,
      lng: -122.0775,
    });
  });

  it("parses lat/lng out of ipinfo's combined 'loc' field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ country: "DE", loc: "52.5244,13.4105" }) })
    );
    const provider = createIpinfoProvider("test-token");
    const result = await provider.lookup("1.2.3.4");
    expect(result?.lat).toBe(52.5244);
    expect(result?.lng).toBe(13.4105);
  });

  it("leaves lat/lng null when 'loc' is missing or malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ country: "DE" }) }));
    const provider = createIpinfoProvider("test-token");
    const result = await provider.lookup("1.2.3.4");
    expect(result?.lat).toBeNull();
    expect(result?.lng).toBeNull();
  });

  it("falls back gracefully when org doesn't match the expected AS-number format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ country: "DE", org: "Some Unusual Org String" }),
      })
    );

    const provider = createIpinfoProvider("test-token");
    const result = await provider.lookup("1.2.3.4");

    expect(result?.asn).toBeNull();
    expect(result?.organization).toBe("Some Unusual Org String");
  });

  it("returns null on a non-ok HTTP response rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const provider = createIpinfoProvider("test-token");
    expect(await provider.lookup("8.8.8.8")).toBeNull();
  });

  it("returns null on a network failure rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const provider = createIpinfoProvider("test-token");
    expect(await provider.lookup("8.8.8.8")).toBeNull();
  });

  it("never persists certainty about hosting-provider status (free tier can't tell)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ country: "US", org: "AS1 Test" }) })
    );
    const provider = createIpinfoProvider("test-token");
    const result = await provider.lookup("8.8.8.8");
    expect(result?.isHostingProvider).toBeNull();
  });
});
