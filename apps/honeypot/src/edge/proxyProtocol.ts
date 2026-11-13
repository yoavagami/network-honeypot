import { isIPv6 } from "node:net";

const SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
/** Custom TLV type carrying the edge fingerprint JSON — nginx reads it as $proxy_protocol_tlv_0xe0. */
export const EDGE_TLV_TYPE = 0xe0;

function v4(addr: string): Buffer {
  return Buffer.from(addr.split(".").map(Number));
}

function v6(addr: string): Buffer {
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, ""];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return out;
}

function normalize(addr: string): string {
  return addr.startsWith("::ffff:") && !addr.slice(7).includes(":") ? addr.slice(7) : addr;
}

/** PROXY protocol v2 header (TCP, PROXY command) with TLVs. */
export function proxyV2Header(src: { address: string; port: number }, dst: { address: string; port: number }, tlvs: Array<[number, Buffer]>): Buffer {
  let s = normalize(src.address);
  let d = normalize(dst.address);
  const ipv6 = isIPv6(s) || isIPv6(d);
  if (ipv6) {
    if (!isIPv6(s)) s = `::ffff:${s}`;
    if (!isIPv6(d)) d = `::ffff:${d}`;
  }
  const addrs = ipv6
    ? Buffer.concat([v6(s.startsWith("::ffff:") && s.includes(".") ? mapped(s) : s), v6(d.startsWith("::ffff:") && d.includes(".") ? mapped(d) : d), port(src.port), port(dst.port)])
    : Buffer.concat([v4(s), v4(d), port(src.port), port(dst.port)]);
  const tlvBuf = Buffer.concat(tlvs.map(([type, value]) => {
    const h = Buffer.alloc(3);
    h[0] = type;
    h.writeUInt16BE(value.length, 1);
    return Buffer.concat([h, value]);
  }));
  const header = Buffer.alloc(4);
  header[0] = 0x21; // version 2, PROXY
  header[1] = ipv6 ? 0x21 : 0x11; // AF_INET6 / AF_INET, STREAM
  header.writeUInt16BE(addrs.length + tlvBuf.length, 2);
  return Buffer.concat([SIGNATURE, header, addrs, tlvBuf]);
}

function port(p: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(p);
  return b;
}

/** "::ffff:1.2.3.4" → "::ffff:102:304" so the plain v6 encoder can handle it. */
function mapped(addr: string): string {
  const [a, b, c, d] = addr.slice(7).split(".").map(Number) as [number, number, number, number];
  return `::ffff:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}
