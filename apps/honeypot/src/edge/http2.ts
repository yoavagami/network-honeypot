/**
 * Reads a client's opening HTTP/2 frames (after TLS) and builds the Akamai-style fingerprint
 *   SETTINGS(id:value;...) | WINDOW_UPDATE increment | PRIORITY frames | pseudo-header order
 * e.g. Chrome: 1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
 *
 * Only the pseudo-header *order* is needed from HPACK, and clients always encode :method /
 * :authority / :path / :scheme via the static table, so this walks the header block without a
 * Huffman decoder and stops at the first regular header.
 */

const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");
const FRAME_DATA = 0x0, FRAME_HEADERS = 0x1, FRAME_PRIORITY = 0x2, FRAME_SETTINGS = 0x4, FRAME_WINDOW_UPDATE = 0x8;

const STATIC_NAMES: Record<number, string> = {
  1: ":authority", 2: ":method", 3: ":method", 4: ":path", 5: ":path", 6: ":scheme", 7: ":scheme",
  8: ":status", 9: ":status", 10: ":status", 11: ":status", 12: ":status", 13: ":status", 14: ":status",
};
const PSEUDO_LETTER: Record<string, string> = { ":method": "m", ":authority": "a", ":scheme": "s", ":path": "p", ":protocol": "r" };

export interface H2Info {
  fp: string;
  settings: Array<[number, number]>;
  windowUpdate: number | null;
  priority: string[];
  headersPriority: string | null;
  pseudoOrder: string | null;
}

export type H2ParseResult = { status: "incomplete" } | { status: "not_h2" } | { status: "ok"; info: H2Info };

export function isH2Preface(buf: Buffer): boolean {
  const n = Math.min(buf.length, PREFACE.length);
  return buf.subarray(0, n).equals(PREFACE.subarray(0, n));
}

/** Parses frames up to and including the first HEADERS frame. */
export function parseH2Start(buf: Buffer): H2ParseResult {
  if (!isH2Preface(buf)) return { status: "not_h2" };
  if (buf.length < PREFACE.length) return { status: "incomplete" };
  let off = PREFACE.length;
  let settings: Array<[number, number]> | null = null;
  let windowUpdate: number | null = null;
  const priority: string[] = [];
  while (true) {
    if (buf.length < off + 9) return { status: "incomplete" };
    const len = buf.readUIntBE(off, 3);
    const type = buf[off + 3]!;
    const flags = buf[off + 4]!;
    const stream = buf.readUInt32BE(off + 5) & 0x7fffffff;
    if (buf.length < off + 9 + len) return { status: "incomplete" };
    const payload = buf.subarray(off + 9, off + 9 + len);
    off += 9 + len;

    if (type === FRAME_SETTINGS && !(flags & 0x1) && settings === null) {
      settings = [];
      for (let i = 0; i + 6 <= payload.length; i += 6) settings.push([payload.readUInt16BE(i), payload.readUInt32BE(i + 2)]);
    } else if (type === FRAME_WINDOW_UPDATE && stream === 0 && windowUpdate === null && payload.length >= 4) {
      windowUpdate = payload.readUInt32BE(0) & 0x7fffffff;
    } else if (type === FRAME_PRIORITY && payload.length >= 5) {
      const dep = payload.readUInt32BE(0);
      priority.push(`${stream}:${dep >>> 31}:${dep & 0x7fffffff}:${payload[4]! + 1}`);
    } else if (type === FRAME_HEADERS) {
      let block = payload;
      let pad = 0;
      if (flags & 0x8) { pad = block[0]!; block = block.subarray(1); }
      let headersPriority: string | null = null;
      if (flags & 0x20) {
        const dep = block.readUInt32BE(0);
        headersPriority = `${dep >>> 31}:${dep & 0x7fffffff}:${block[4]! + 1}`;
        block = block.subarray(5);
      }
      if (pad) block = block.subarray(0, Math.max(0, block.length - pad));
      const pseudo = pseudoHeaderOrder(block);
      const pseudoOrder = pseudo.length ? pseudo.map((n) => PSEUDO_LETTER[n] ?? "?").join(",") : null;
      const s = settings ?? [];
      const fp = [
        s.map(([k, v]) => `${k}:${v}`).join(";"),
        windowUpdate === null ? "00" : String(windowUpdate),
        priority.length ? priority.join(",") : "0",
        pseudoOrder ?? "",
      ].join("|");
      return { status: "ok", info: { fp, settings: s, windowUpdate, priority, headersPriority, pseudoOrder } };
    } else if (type === FRAME_DATA) {
      return { status: "not_h2" }; // data before headers — not a normal client opening
    }
    if (off > 65_536) return { status: "not_h2" };
  }
}

function readInt(buf: Buffer, pos: number, prefixBits: number): [number, number] {
  const max = (1 << prefixBits) - 1;
  let value = buf[pos]! & max;
  pos++;
  if (value < max) return [value, pos];
  let m = 0;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    value += (b & 0x7f) * 2 ** m;
    m += 7;
    if (!(b & 0x80)) break;
  }
  return [value, pos];
}

function skipString(buf: Buffer, pos: number): number {
  const [len, p] = readInt(buf, pos, 7);
  return p + len;
}

/** Pseudo-header names in the order they appear at the start of an HPACK block. */
export function pseudoHeaderOrder(block: Buffer): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < block.length && out.length < 6) {
    const b = block[pos]!;
    let index: number;
    if (b & 0x80) { // indexed header field
      [index, pos] = readInt(block, pos, 7);
      const name = STATIC_NAMES[index];
      if (!name) break;
      out.push(name);
      continue;
    }
    if ((b & 0xe0) === 0x20) { // dynamic table size update
      [, pos] = readInt(block, pos, 5);
      continue;
    }
    const prefix = (b & 0xc0) === 0x40 ? 6 : 4; // incremental indexing : without/never indexed
    [index, pos] = readInt(block, pos, prefix);
    if (index === 0) break; // literal name — regular headers from here on (or :protocol, ignored)
    const name = STATIC_NAMES[index];
    if (!name) break;
    out.push(name);
    pos = skipString(block, pos);
  }
  return out.filter((n) => n !== ":status");
}
