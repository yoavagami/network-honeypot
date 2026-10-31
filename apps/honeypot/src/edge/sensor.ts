import { createServer as createNetServer, connect, type Socket } from "node:net";
import { createServer as createTlsServer, createSecureContext, type SecureContext, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseClientHello, fingerprint, type ClientHello } from "./clientHello.js";
import { parseH2Start, isH2Preface } from "./http2.js";
import { proxyV2Header, EDGE_TLV_TYPE } from "./proxyProtocol.js";
import type { EdgeInfo } from "../sensing/edge.js";

/**
 * Edge sensor — the public :443 listener, in front of nginx.
 *
 *   client ──TLS──► sensor ──plain HTTP + PROXY v2──► nginx (edge listener) ──► honeypot app
 *
 * Per connection it records what nginx can't expose: the raw TLS ClientHello (JA3/JA4), the
 * client's opening HTTP/2 frames (SETTINGS / WINDOW_UPDATE / PRIORITY / pseudo-header order) or,
 * for HTTP/1.1, the raw header names in original order and case. It then terminates TLS with the
 * same Let's Encrypt certificate nginx uses and hands the decrypted stream to nginx with a PROXY
 * v2 header carrying the real client address plus the fingerprint (TLV 0xE0). nginx keeps doing
 * everything it did before (real client IP via real_ip, rate limits, routing) and passes the
 * fingerprint to the app as X-HP-Edge.
 *
 * Failure handling: every connection is independent and every error just closes that
 * connection. A client that can't be fingerprinted is still served, with what was learned.
 * Nothing is written to disk. Rollback is publishing 443 from nginx again
 * (infrastructure/vps/docker-compose.tls.yml).
 */

const LISTEN_PORT = Number(process.env.EDGE_PORT ?? 8443);
const UPSTREAM_HOST = process.env.EDGE_UPSTREAM_HOST ?? "nginx";
const UPSTREAM_PORT = Number(process.env.EDGE_UPSTREAM_PORT ?? 8443);
const CERT_DIR = process.env.EDGE_CERT_DIR ?? "";
const HELLO_TIMEOUT_MS = 10_000;
const FIRST_DATA_TIMEOUT_MS = 3_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_PEEK = 64 * 1024;
const MAX_TLV = 6_000;

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ level, service: "edge", time: new Date().toISOString(), msg, ...extra })}\n`);
}

let secureContext: SecureContext;
function loadCert() {
  secureContext = createSecureContext({
    cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
    key: readFileSync(`${CERT_DIR}/privkey.pem`),
    minVersion: "TLSv1.2",
  });
}

const tlsServer = createTlsServer({
  SNICallback: (_name, cb) => cb(null, secureContext),
  ALPNProtocols: ["h2", "http/1.1"],
  minVersion: "TLSv1.2",
  handshakeTimeout: HELLO_TIMEOUT_MS,
});
tlsServer.on("tlsClientError", (_err, sock) => {
  pending.delete(connKey(sock));
  sock.destroy();
});

interface ConnState {
  id: string;
  client: Socket;
  acceptedAt: number;
  helloAt?: number;
  hello?: ClientHello;
  helloError?: string;
}
/** Connections between ClientHello and TLS handshake, keyed by remote address:port. */
const pending = new Map<string, ConnState>();
const connKey = (s: { remoteAddress?: string; remotePort?: number }) => `${s.remoteAddress}:${s.remotePort}`;

function buildEdgeInfo(state: ConnState, extra: Partial<EdgeInfo>): EdgeInfo {
  const info: EdgeInfo = { v: 1, conn: state.id, tls: true, ...extra };
  if (state.hello) {
    const h = state.hello;
    Object.assign(info, fingerprint(h));
    info.hello = {
      sni: h.sni, alpn: h.alpn, versions: h.supportedVersions, ciphers: h.ciphers, extensions: h.extensions,
      groups: h.supportedGroups, sigalgs: h.signatureAlgorithms, keyShare: h.keyShareGroups, pskModes: h.pskModes,
      compressCert: h.compressCertificate, ech: h.hasEch, grease: h.hasGrease, recordSizeLimit: h.recordSizeLimit,
      padding: h.paddingLength, sessionIdLength: h.sessionIdLength,
    };
  }
  if (state.helloError) info.error = state.helloError;
  return info;
}

function encodeTlv(info: EdgeInfo): Buffer {
  let json = JSON.stringify(info);
  if (Buffer.byteLength(json) * 4 / 3 > MAX_TLV) {
    // Keep the fingerprints, drop the bulky raw lists.
    const { hello, ...rest } = info;
    json = JSON.stringify({ ...rest, hello: hello ? { sni: hello.sni, alpn: hello.alpn, grease: hello.grease, ech: hello.ech } : undefined, truncated: true });
  }
  return Buffer.from(Buffer.from(json, "utf8").toString("base64url"), "latin1");
}

/** Opens the upstream nginx connection and splices it to `downstream` once `head` is written. */
function forward(state: ConnState, downstream: Duplex | Socket, head: Buffer, info: EdgeInfo) {
  const client = state.client;
  const upstream = connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  upstream.setNoDelay(true);
  const kill = () => { upstream.destroy(); downstream.destroy(); client.destroy(); };
  upstream.on("error", (err) => { log("warn", "upstream error", { conn: state.id, err: err.message }); kill(); });
  downstream.on("error", kill);
  upstream.on("connect", () => {
    const header = proxyV2Header(
      { address: client.remoteAddress ?? "0.0.0.0", port: client.remotePort ?? 0 },
      { address: client.localAddress ?? "0.0.0.0", port: client.localPort ?? 0 },
      [[EDGE_TLV_TYPE, encodeTlv(info)]]
    );
    upstream.write(Buffer.concat([header, head]));
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.resume();
  });
  upstream.setTimeout(IDLE_TIMEOUT_MS, kill);
}

tlsServer.on("secureConnection", (tlsSocket: TLSSocket) => {
  const state = pending.get(connKey(tlsSocket));
  pending.delete(connKey(tlsSocket));
  if (!state) { tlsSocket.destroy(); return; }
  const handshakeMs = Date.now() - state.acceptedAt;
  const alpn = typeof tlsSocket.alpnProtocol === "string" ? tlsSocket.alpnProtocol : null;
  const negotiated = { alpn, version: tlsSocket.getProtocol() ?? null, cipher: tlsSocket.getCipher()?.name ?? null };
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (extra: Partial<EdgeInfo>) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    tlsSocket.removeListener("data", onData);
    tlsSocket.pause();
    const info = buildEdgeInfo(state, {
      ...extra,
      negotiated,
      timing: { helloMs: (state.helloAt ?? state.acceptedAt) - state.acceptedAt, handshakeMs, firstDataMs: buf.length ? Date.now() - state.acceptedAt : null },
    });
    forward(state, tlsSocket, buf, info);
  };
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_PEEK) return finish({});
    if (alpn === "h2" || isH2Preface(buf)) {
      const r = parseH2Start(buf);
      if (r.status === "ok") return finish({ h2: r.info });
      if (r.status === "not_h2") return finish({});
    } else {
      const end = buf.indexOf("\r\n\r\n");
      if (end !== -1) {
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n").slice(1);
        return finish({ h1: { headerNames: lines.map((l) => l.split(":")[0]!.trim()).filter(Boolean).slice(0, 60) } });
      }
    }
  };
  const timer = setTimeout(() => finish({}), FIRST_DATA_TIMEOUT_MS);
  tlsSocket.on("data", onData);
  tlsSocket.on("error", () => { clearTimeout(timer); tlsSocket.destroy(); });
});

function handleTls(state: ConnState, head: Buffer) {
  // Put the ClientHello back and let tls.Server take the socket over — TLSSocket drains a
  // socket's already-buffered bytes into the TLS engine before reading from the handle.
  const key = connKey(state.client);
  pending.set(key, state);
  state.client.once("close", () => pending.delete(key));
  state.client.unshift(head);
  tlsServer.emit("connection", state.client);
}

const server = createNetServer({ pauseOnConnect: false }, (client) => {
  const state: ConnState = { id: randomBytes(6).toString("hex"), client, acceptedAt: Date.now() };
  client.setNoDelay(true);
  client.setTimeout(HELLO_TIMEOUT_MS, () => client.destroy());
  client.on("error", () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const r = parseClientHello(buf);
    if (r.status === "incomplete" && buf.length < 32 * 1024) return;
    client.removeListener("data", onData);
    client.pause();
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    state.helloAt = Date.now();
    if (r.status === "not_tls") {
      // Plain HTTP (or anything else) sent to :443 — pass it through so it's still logged.
      forward(state, client, buf, { v: 1, conn: state.id, tls: false });
      return;
    }
    if (r.status === "ok") state.hello = r.hello;
    else state.helloError = r.status === "error" ? r.error : "ClientHello too large";
    handleTls(state, buf);
  };
  client.on("data", onData);
});

loadCert();
setInterval(() => {
  try {
    loadCert();
  } catch (err) {
    log("error", "certificate reload failed, keeping the previous one", { err: err instanceof Error ? err.message : String(err) });
  }
}, 6 * 3600_000).unref();

server.on("error", (err) => { log("error", "listener error", { err: err.message }); process.exit(1); });
server.listen(LISTEN_PORT, "0.0.0.0", () => log("info", "edge sensor listening", { port: LISTEN_PORT, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }));
process.on("SIGTERM", () => { server.close(); process.exit(0); });
