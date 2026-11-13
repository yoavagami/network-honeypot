import { createHash } from "node:crypto";

/**
 * TLS ClientHello parser + JA3/JA4 fingerprints. Works on the raw bytes the edge sensor reads
 * off the TCP socket before the TLS handshake (see edge/sensor.ts) — the only place these
 * fields exist; nginx's ssl variables only expose the *negotiated* result.
 *
 * JA4 follows FoxIO's spec (github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md):
 *   a = t{version}{d|i}{ciphers:2}{extensions:2}{alpn first+last char}
 *   b = sha256(sorted ciphers)[:12]
 *   c = sha256(sorted extensions without SNI/ALPN + "_" + signature algorithms in order)[:12]
 * GREASE values are ignored everywhere.
 */

export interface ClientHello {
  recordVersion: number;
  clientVersion: number;
  sessionIdLength: number;
  ciphers: number[];
  compressionMethods: number[];
  extensions: number[]; // in wire order, GREASE included
  sni: string | null;
  alpn: string[];
  supportedVersions: number[];
  supportedGroups: number[];
  ecPointFormats: number[];
  signatureAlgorithms: number[];
  keyShareGroups: number[];
  pskModes: number[];
  compressCertificate: number[];
  hasEch: boolean;
  hasGrease: boolean;
  recordSizeLimit: number | null;
  paddingLength: number | null;
}

export type ParseResult =
  | { status: "ok"; hello: ClientHello; consumed: number }
  | { status: "incomplete" }
  | { status: "not_tls" }
  | { status: "error"; error: string };

export function isGrease(v: number): boolean {
  return (v & 0x0f0f) === 0x0a0a && (v >> 8) === (v & 0xff);
}

/** Parses a ClientHello out of the first TLS records in `buf` (which may span records). */
export function parseClientHello(buf: Buffer): ParseResult {
  if (buf.length === 0) return { status: "incomplete" };
  if (buf[0] !== 0x16) return { status: "not_tls" };
  // Reassemble the handshake message across records.
  const parts: Buffer[] = [];
  let offset = 0;
  let recordVersion = 0;
  let needed: number | null = null;
  let have = 0;
  while (true) {
    if (buf.length < offset + 5) return { status: "incomplete" };
    if (buf[offset] !== 0x16) return { status: "error", error: "non-handshake record before ClientHello complete" };
    if (offset === 0) recordVersion = buf.readUInt16BE(1);
    const len = buf.readUInt16BE(offset + 3);
    if (len > 18_432) return { status: "error", error: "record too large" };
    if (buf.length < offset + 5 + len) return { status: "incomplete" };
    parts.push(buf.subarray(offset + 5, offset + 5 + len));
    have += len;
    offset += 5 + len;
    if (needed === null) {
      const first = Buffer.concat(parts);
      if (first.length < 4) continue;
      if (first[0] !== 0x01) return { status: "error", error: "first handshake message is not ClientHello" };
      needed = 4 + first.readUIntBE(1, 3);
      if (needed > 65_536) return { status: "error", error: "ClientHello too large" };
    }
    if (have >= needed) break;
  }
  const hs = Buffer.concat(parts).subarray(0, needed!);
  try {
    return { status: "ok", hello: parseHandshakeBody(hs.subarray(4), recordVersion), consumed: offset };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

class Reader {
  constructor(private readonly b: Buffer, public pos = 0) {}
  get left() { return this.b.length - this.pos; }
  u8() { this.need(1); return this.b[this.pos++]!; }
  u16() { this.need(2); const v = this.b.readUInt16BE(this.pos); this.pos += 2; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  private need(n: number) { if (this.pos + n > this.b.length) throw new Error("truncated ClientHello"); }
}

function u16List(data: Buffer, lenBytes: 1 | 2): number[] {
  const r = new Reader(data);
  const len = lenBytes === 1 ? r.u8() : r.u16();
  const body = new Reader(r.bytes(len));
  const out: number[] = [];
  while (body.left >= 2) out.push(body.u16());
  return out;
}

function parseHandshakeBody(body: Buffer, recordVersion: number): ClientHello {
  const r = new Reader(body);
  const clientVersion = r.u16();
  r.bytes(32); // random
  const sessionIdLength = r.u8();
  r.bytes(sessionIdLength);
  const cipherBytes = r.u16();
  const cr = new Reader(r.bytes(cipherBytes));
  const ciphers: number[] = [];
  while (cr.left >= 2) ciphers.push(cr.u16());
  const compLen = r.u8();
  const compressionMethods = [...r.bytes(compLen)];

  const hello: ClientHello = {
    recordVersion, clientVersion, sessionIdLength, ciphers, compressionMethods,
    extensions: [], sni: null, alpn: [], supportedVersions: [], supportedGroups: [], ecPointFormats: [],
    signatureAlgorithms: [], keyShareGroups: [], pskModes: [], compressCertificate: [],
    hasEch: false, hasGrease: ciphers.some(isGrease), recordSizeLimit: null, paddingLength: null,
  };
  if (r.left < 2) return hello;
  const extTotal = r.u16();
  const er = new Reader(r.bytes(Math.min(extTotal, r.left)));
  while (er.left >= 4) {
    const type = er.u16();
    const data = er.bytes(er.u16());
    hello.extensions.push(type);
    if (isGrease(type)) { hello.hasGrease = true; continue; }
    try {
      switch (type) {
        case 0x0000: { // server_name
          const x = new Reader(data); x.u16();
          if (x.left >= 3 && x.u8() === 0) hello.sni = x.bytes(x.u16()).toString("latin1");
          break;
        }
        case 0x0010: { // ALPN
          const x = new Reader(data); const l = x.u16(); const y = new Reader(x.bytes(l));
          while (y.left > 0) hello.alpn.push(y.bytes(y.u8()).toString("latin1"));
          break;
        }
        case 0x000a: hello.supportedGroups = u16List(data, 2); break;
        case 0x000b: { const x = new Reader(data); hello.ecPointFormats = [...x.bytes(x.u8())]; break; }
        case 0x000d: hello.signatureAlgorithms = u16List(data, 2); break;
        case 0x002b: hello.supportedVersions = u16List(data, 1); break;
        case 0x002d: { const x = new Reader(data); hello.pskModes = [...x.bytes(x.u8())]; break; }
        case 0x001b: hello.compressCertificate = u16List(data, 1); break;
        case 0x001c: hello.recordSizeLimit = data.readUInt16BE(0); break;
        case 0x0015: hello.paddingLength = data.length; break;
        case 0xfe0d: hello.hasEch = true; break;
        case 0x0033: { // key_share
          const x = new Reader(data); const l = x.u16(); const y = new Reader(x.bytes(l));
          while (y.left >= 4) { hello.keyShareGroups.push(y.u16()); y.bytes(y.u16()); }
          break;
        }
      }
    } catch {
      // A malformed single extension shouldn't lose the whole fingerprint.
    }
  }
  if (hello.supportedGroups.some(isGrease) || hello.supportedVersions.some(isGrease)) hello.hasGrease = true;
  return hello;
}

const hex4 = (v: number) => v.toString(16).padStart(4, "0");
const sha12 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function versionCode(v: number): string {
  switch (v) {
    case 0x0304: return "13";
    case 0x0303: return "12";
    case 0x0302: return "11";
    case 0x0301: return "10";
    case 0x0300: return "s3";
    case 0x0002: return "s2";
    case 0xfeff: return "d1";
    case 0xfefd: return "d2";
    case 0xfefc: return "d3";
    default: return "00";
  }
}

function alpnCode(alpn: string | undefined): string {
  if (!alpn) return "00";
  const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);
  const first = alpn[0]!;
  const last = alpn[alpn.length - 1]!;
  if (isAlnum(first) && isAlnum(last)) return first + last;
  const hex = Buffer.from(alpn, "latin1").toString("hex");
  return hex[0]! + hex[hex.length - 1]!;
}

export interface TlsFingerprints {
  ja4: string;
  ja4_r: string;
  ja3: string;
  ja3_hash: string;
  /** JA3 with extensions sorted — stable across Chrome's per-connection extension shuffling. */
  ja3n_hash: string;
}

export function fingerprint(h: ClientHello): TlsFingerprints {
  const ciphers = h.ciphers.filter((c) => !isGrease(c));
  const exts = h.extensions.filter((e) => !isGrease(e));
  const versions = h.supportedVersions.filter((v) => !isGrease(v));
  const version = versions.length > 0 ? Math.max(...versions) : h.clientVersion;
  const count = (n: number) => String(Math.min(n, 99)).padStart(2, "0");

  const a = `t${versionCode(version)}${h.sni !== null ? "d" : "i"}${count(ciphers.length)}${count(exts.length)}${alpnCode(h.alpn[0])}`;
  const cipherStr = ciphers.map(hex4).sort().join(",");
  const extStr = exts.filter((e) => e !== 0x0000 && e !== 0x0010).map(hex4).sort().join(",");
  const sigStr = h.signatureAlgorithms.filter((s) => !isGrease(s)).map(hex4).join(",");
  const cInput = sigStr ? `${extStr}_${sigStr}` : extStr;
  const b = ciphers.length ? sha12(cipherStr) : "000000000000";
  const c = exts.length ? sha12(cInput) : "000000000000";

  const groups = h.supportedGroups.filter((g) => !isGrease(g));
  const ja3Parts = (extOrder: number[]) =>
    [h.clientVersion, ciphers.join("-"), extOrder.join("-"), groups.join("-"), h.ecPointFormats.join("-")].join(",");
  const ja3 = ja3Parts(exts);
  return {
    ja4: `${a}_${b}_${c}`,
    ja4_r: `${a}_${cipherStr}_${cInput}`,
    ja3,
    ja3_hash: md5(ja3),
    ja3n_hash: md5(ja3Parts([...exts].sort((x, y) => x - y))),
  };
}
