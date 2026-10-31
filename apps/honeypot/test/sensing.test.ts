import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { connect } from "node:tls";
import { verifyWebBotAuth, jwkThumbprint, resetWebBotAuthCache, type SignedRequest } from "../src/sensing/webBotAuth.js";
import { decideIdentity } from "../src/sensing/verdict.js";
import { parseUserAgent } from "../src/sensing/userAgent.js";
import { captureHeaders, consistencyFlags } from "../src/sensing/headers.js";
import { agentRangesFor, loadBundledRanges } from "../src/sensing/ipIntel.js";
import { parseClientHello, fingerprint, isGrease } from "../src/edge/clientHello.js";

// ---------------------------------------------------------------- Web Bot Auth

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
const keyid = jwkThumbprint(jwk)!;
const directory = { keys: [jwk] };

function signedRequest(opts: { host?: string; tamper?: boolean; created?: number; expires?: number; agent?: string } = {}): SignedRequest {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const expires = opts.expires ?? created + 60;
  const agent = opts.agent ?? '"https://chatgpt.com"';
  const params = `("@authority" "signature-agent");created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";nonce="abc";tag="web-bot-auth"`;
  const base = `"@authority": uhoney.shop\n"signature-agent": ${agent}\n"@signature-params": ${params}`;
  const sig = sign(null, Buffer.from(base), privateKey).toString("base64");
  const headers: Record<string, string> = {
    "signature-agent": agent,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${sig}:`,
  };
  return {
    method: "GET",
    url: "/",
    host: opts.tamper ? "evil.example" : opts.host ?? "uhoney.shop",
    header: (n) => (headers[n] !== undefined ? [headers[n]!] : []),
  };
}
const fetcher = async () => directory;

describe("web bot auth", () => {
  beforeEach(() => resetWebBotAuthCache());

  it("verifies a correctly signed request", async () => {
    const r = await verifyWebBotAuth(signedRequest(), { fetcher });
    expect(r.status).toBe("verified");
    expect(r.signer).toBe("https://chatgpt.com");
  });
  it("rejects a signature over a different authority", async () => {
    expect((await verifyWebBotAuth(signedRequest({ tamper: true }), { fetcher })).status).toBe("invalid_signature");
  });
  it("rejects an expired signature", async () => {
    const created = Math.floor(Date.now() / 1000) - 600;
    expect((await verifyWebBotAuth(signedRequest({ created, expires: created + 60 }), { fetcher })).status).toBe("expired");
  });
  it("reports key_not_found when the directory has a different key", async () => {
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as JsonWebKey;
    expect((await verifyWebBotAuth(signedRequest(), { fetcher: async () => ({ keys: [other] }) })).status).toBe("key_not_found");
  });
  it("is absent with no signature headers", async () => {
    expect((await verifyWebBotAuth({ method: "GET", url: "/", host: "uhoney.shop", header: () => [] }, { fetcher })).status).toBe("absent");
  });
  it("flags a Signature-Agent header with no signature as malformed", async () => {
    const r = await verifyWebBotAuth({ method: "GET", url: "/", host: "uhoney.shop", header: (n) => (n === "signature-agent" ? ['"https://chatgpt.com"'] : []) }, { fetcher });
    expect(r.status).toBe("malformed");
  });
});

// ---------------------------------------------------------------- identity verdicts

describe("identity verdict", () => {
  beforeAll(() => loadBundledRanges());
  const noWba = { status: "absent" as const, signer: null };
  const chatgptUserUa = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)";

  it("verifies ChatGPT-User from an OpenAI ChatGPT-User range", () => {
    const ip = "104.208.184.193"; // inside 104.208.184.192/28 in openai-chatgpt-user.json
    const v = decideIdentity({ ua: parseUserAgent(chatgptUserUa), rawUa: chatgptUserUa, ipRanges: agentRangesFor(ip), rdns: null, wba: noWba, consistencyFlags: [] });
    expect(v.verdict).toBe("verified");
    expect(v.agent).toBe("chatgpt-user");
  });
  it("calls ChatGPT-User from Cloudflare WARP (seen live Oct 28) spoofed", () => {
    const ip = "104.28.229.13";
    const v = decideIdentity({ ua: parseUserAgent(chatgptUserUa), rawUa: chatgptUserUa, ipRanges: agentRangesFor(ip), rdns: null, wba: noWba, consistencyFlags: [] });
    expect(v.verdict).toBe("spoofed");
  });
  it("leaves an unverifiable claim as claimed", () => {
    const ua = "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com) AppleWebKit/537.36";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: null, wba: noWba, consistencyFlags: [] });
    expect(v.verdict).toBe("claimed");
  });
  it("verifies a signed ChatGPT agent even with a plain Chrome user-agent", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: null, wba: { status: "verified", signer: "https://chatgpt.com", keyid: "k" }, consistencyFlags: [] });
    expect(v).toMatchObject({ verdict: "verified", agent: "chatgpt-agent", method: "web_bot_auth" });
  });
  it("calls a Googlebot claim without forward-confirmed rDNS spoofed", () => {
    const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: { ptr: "googlebot.com.evil.net", forwardConfirmed: true }, wba: noWba, consistencyFlags: [] });
    expect(v.verdict).toBe("spoofed");
  });
  it("does not accept a Google Cloud customer's rDNS as Googlebot (seen live Oct 27)", () => {
    const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: { ptr: "215.135.194.35.bc.googleusercontent.com", forwardConfirmed: true }, wba: noWba, consistencyFlags: [] });
    expect(v.verdict).toBe("spoofed");
  });
  it("labels HTTP libraries as automation", () => {
    const v = decideIdentity({ ua: parseUserAgent("python-requests/2.32.5"), rawUa: "python-requests/2.32.5", ipRanges: [], rdns: null, wba: noWba, consistencyFlags: [] });
    expect(v).toMatchObject({ verdict: "automation", agent: "python-requests" });
  });
  // Lab runs 2026-10-31.
  it("verifies claude.ai's web fetch from Anthropic's own network", () => {
    const ua = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: ["anthropic-egress"], rdns: { ptr: null, forwardConfirmed: false }, wba: noWba, consistencyFlags: [] });
    expect(v).toMatchObject({ verdict: "verified", agent: "claude-user" });
  });
  it("treats Claude Code's fetch from a home IP as claimed, not spoofed", () => {
    const ua = "Claude-User (claude-code/2.1.309; +https://support.anthropic.com/)";
    const v = decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: { ptr: "188-142-44-123.fixed.kpn.net", forwardConfirmed: true }, wba: noWba, consistencyFlags: [] });
    expect(v).toMatchObject({ verdict: "claimed", agent: "claude-code" });
  });
  it("verifies Gemini's fetch (user-agent 'Google') by Google rDNS, and only the bare word", () => {
    const v = decideIdentity({ ua: parseUserAgent("Google"), rawUa: "Google", ipRanges: [], rdns: { ptr: "rate-limited-proxy-142-250-88-66.google.com", forwardConfirmed: true }, wba: noWba, consistencyFlags: [] });
    expect(v).toMatchObject({ verdict: "verified", agent: "google-user-fetch" });
    expect(decideIdentity({ ua: parseUserAgent("Google"), rawUa: "Google", ipRanges: [], rdns: { ptr: "x.bc.googleusercontent.com", forwardConfirmed: true }, wba: noWba, consistencyFlags: [] }).verdict).toBe("spoofed");
    expect(parseUserAgent("Google Chrome helper").claim).toBeNull();
  });
  it("recognises the Claude desktop app", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/3.6556.2 Chrome/152.0.7977.167 Safari/537.36";
    expect(decideIdentity({ ua: parseUserAgent(ua), rawUa: ua, ipRanges: [], rdns: null, wba: noWba, consistencyFlags: [] })).toMatchObject({ verdict: "ai_app", agent: "claude-desktop" });
  });
});

// ---------------------------------------------------------------- headers

describe("header consistency", () => {
  it("flags a Chrome user-agent sent by a script", () => {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const h = captureHeaders(["Host", "uhoney.shop", "User-Agent", ua, "Accept", "*/*", "Accept-Encoding", "gzip, deflate", "Connection", "keep-alive"]);
    const flags = consistencyFlags(h, parseUserAgent(ua), true, { hasGrease: false, alpnOffered: ["http/1.1"] });
    expect(flags).toEqual(expect.arrayContaining(["chromium_ua_without_client_hints", "chromium_ua_without_sec_fetch", "no_accept_language", "accept_encoding_without_br", "tls_not_chromium", "tls_no_h2_offered"]));
    expect(h.order).toEqual(["User-Agent", "Accept", "Accept-Encoding"]);
  });
  it("never stores cookie or authorization values", () => {
    const h = captureHeaders(["Cookie", "hp_session=secret123; other=x", "Authorization", "Bearer abc.def", "X-Api-Key", "k123"]);
    expect(JSON.stringify(h)).not.toMatch(/secret123|abc\.def|k123/);
    expect(h.cookieNames).toEqual(["hp_session", "other"]);
  });
});

// ---------------------------------------------------------------- TLS ClientHello

async function captureHello(opts: { alpn?: string[]; servername?: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on("data", (d) => {
        chunks.push(d);
        const buf = Buffer.concat(chunks);
        if (parseClientHello(buf).status !== "incomplete") {
          resolve(buf);
          sock.destroy();
          server.close();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const c = connect({ host: "127.0.0.1", port, servername: opts.servername, ALPNProtocols: opts.alpn, rejectUnauthorized: false });
      c.on("error", () => {});
    });
    server.on("error", reject);
  });
}

describe("ClientHello / JA4", () => {
  it("parses a real Node TLS ClientHello", async () => {
    const buf = await captureHello({ alpn: ["h2", "http/1.1"], servername: "uhoney.shop" });
    const r = parseClientHello(buf);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.hello.sni).toBe("uhoney.shop");
    expect(r.hello.alpn).toEqual(["h2", "http/1.1"]);
    expect(r.hello.supportedVersions).toContain(0x0304);
    const fp = fingerprint(r.hello);
    expect(fp.ja4).toMatch(/^t13d\d{4}h2_[0-9a-f]{12}_[0-9a-f]{12}$/);
    expect(fp.ja3_hash).toMatch(/^[0-9a-f]{32}$/);
  });
  it("uses 'i' and '00' without SNI or ALPN", async () => {
    const r = parseClientHello(await captureHello({}));
    expect(r.status === "ok" && fingerprint(r.hello).ja4.slice(3, 4)).toBe("i");
    expect(r.status === "ok" && fingerprint(r.hello).ja4.slice(8, 10)).toBe("00");
  });
  it("rejects non-TLS bytes and waits for more on a partial record", () => {
    expect(parseClientHello(Buffer.from("GET / HTTP/1.1\r\n")).status).toBe("not_tls");
    expect(parseClientHello(Buffer.from([0x16, 0x03, 0x01, 0x02])).status).toBe("incomplete");
  });
  it("recognises GREASE values", () => {
    expect(isGrease(0x0a0a)).toBe(true);
    expect(isGrease(0xfafa)).toBe(true);
    expect(isGrease(0x1301)).toBe(false);
  });
});

// ---------------------------------------------------------------- HTTP/2 + PROXY protocol

import { parseH2Start, pseudoHeaderOrder } from "../src/edge/http2.js";
import { proxyV2Header } from "../src/edge/proxyProtocol.js";

function frame(type: number, flags: number, stream: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(9);
  h.writeUIntBE(payload.length, 0, 3);
  h[3] = type;
  h[4] = flags;
  h.writeUInt32BE(stream, 5);
  return Buffer.concat([h, payload]);
}

describe("HTTP/2 opening fingerprint", () => {
  // Chrome-like opening: SETTINGS, WINDOW_UPDATE, HEADERS(:method GET, :authority, :scheme https, :path /)
  const settings = Buffer.alloc(24);
  [[1, 65536], [2, 0], [4, 6291456], [6, 262144]].forEach(([k, v], i) => { settings.writeUInt16BE(k!, i * 6); settings.writeUInt32BE(v!, i * 6 + 2); });
  const wu = Buffer.alloc(4); wu.writeUInt32BE(15663105);
  const host = Buffer.from("uhoney.shop");
  const block = Buffer.concat([Buffer.from([0x82, 0x41, host.length]), host, Buffer.from([0x87, 0x84, 0x40 | 0, 0x03]), Buffer.from("abc"), Buffer.from([0x01]), Buffer.from("x")]);
  const prio = Buffer.from([0x80, 0, 0, 0, 255]); // exclusive, dep 0, weight 256
  const opening = Buffer.concat([
    Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"),
    frame(0x4, 0, 0, settings),
    frame(0x8, 0, 0, wu),
    frame(0x1, 0x4 | 0x1 | 0x20, 1, Buffer.concat([prio, block])),
  ]);

  it("builds the Akamai fingerprint with Chrome's pseudo-header order", () => {
    const r = parseH2Start(opening);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.info.fp).toBe("1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p");
    expect(r.info.headersPriority).toBe("1:0:256");
  });
  it("waits for more bytes mid-frame and rejects non-h2", () => {
    expect(parseH2Start(opening.subarray(0, 40)).status).toBe("incomplete");
    expect(parseH2Start(Buffer.from("GET / HTTP/1.1\r\n")).status).toBe("not_h2");
  });
  it("reads Firefox/curl-style orders", () => {
    expect(pseudoHeaderOrder(Buffer.from([0x82, 0x84, 0x87, 0x41, 0x01, 0x61]))).toEqual([":method", ":path", ":scheme", ":authority"]);
  });
});

describe("PROXY v2 header", () => {
  it("encodes an IPv4 client with a TLV", () => {
    const h = proxyV2Header({ address: "::ffff:1.2.3.4", port: 5555 }, { address: "172.20.0.5", port: 8443 }, [[0xe0, Buffer.from("abc")]]);
    expect(h.subarray(0, 12).toString("hex")).toBe("0d0a0d0a000d0a515549540a");
    expect(h[12]).toBe(0x21);
    expect(h[13]).toBe(0x11);
    expect(h.readUInt16BE(14)).toBe(12 + 6);
    expect([...h.subarray(16, 20)]).toEqual([1, 2, 3, 4]);
    expect(h.readUInt16BE(24)).toBe(5555);
    expect(h[28]).toBe(0xe0);
    expect(h.subarray(31).toString()).toBe("abc");
  });
  it("encodes IPv6", () => {
    const h = proxyV2Header({ address: "2001:db8::1", port: 1 }, { address: "::1", port: 2 }, []);
    expect(h[13]).toBe(0x21);
    expect(h.readUInt16BE(14)).toBe(36);
    expect(h.subarray(16, 32).toString("hex")).toBe("20010db8000000000000000000000001");
  });
});
