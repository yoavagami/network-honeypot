import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";

/**
 * Outbound HTTP to merchant-supplied hosts (webhook URLs, domain verification) without becoming a
 * way into our own network: the connection's DNS lookup refuses private, loopback, link-local and
 * other non-public addresses, so the check applies to the address actually connected to (no
 * rebinding gap). No redirects are followed; bodies and time are capped.
 */
const blocked = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true;
}

export interface OutboundResult { status: number; body: string }

export function outbound(opts: {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}): Promise<OutboundResult> {
  const u = new URL(opts.url);
  if (u.protocol !== "https:" && !(opts.allowPrivate && u.protocol === "http:")) return Promise.reject(new Error("only https URLs are allowed"));
  if (u.username || u.password) return Promise.reject(new Error("credentials in URL are not allowed"));
  const lookup: any = (hostname: string, options: any, cb: any) => {
    dnsLookup(hostname, { ...options, all: false }, (err, address, family) => {
      if (err) return cb(err);
      if (!opts.allowPrivate && isPrivateAddress(address as string)) return cb(new Error(`refusing non-public address for ${hostname}`));
      cb(null, address, family);
    });
  };
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: opts.method,
      headers: { "user-agent": "uHoney-Webhooks/1.0", ...(opts.headers ?? {}), ...(opts.body !== undefined ? { "content-length": String(Buffer.byteLength(opts.body)) } : {}) },
      lookup,
      timeout: opts.timeoutMs ?? 5000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("close", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
