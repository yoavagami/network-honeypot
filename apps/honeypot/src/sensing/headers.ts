import { createHash } from "node:crypto";
import type { UaInfo } from "./userAgent.js";

/** Headers nginx sets itself on the way to the app (proxy_params_*.conf) — not the client's. */
const PROXY_ADDED = new Set([
  "host", "x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-request-id",
  "x-tls-version", "x-tls-cipher", "x-alpn-protocol", "connection", "x-hp-edge",
]);
const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|session|csrf|xsrf/i;
const MAX_VALUE = 512;

export interface HeaderCapture {
  /** Client header names in received order (nginx-added ones removed). */
  order: string[];
  /** sha256 of the lowercase order, first 16 hex chars — groups identical clients. */
  orderHash: string;
  /** Values, with cookie/authorization/secret-looking values reduced to non-sensitive facts. */
  values: Record<string, string>;
  cookieNames: string[];
}

export function captureHeaders(rawHeaders: string[]): HeaderCapture {
  const order: string[] = [];
  const values: Record<string, string> = {};
  const cookieNames: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const lower = name.toLowerCase();
    const value = rawHeaders[i + 1]!;
    if (PROXY_ADDED.has(lower)) continue;
    order.push(name);
    let stored: string;
    if (lower === "cookie") {
      for (const part of value.split(";")) {
        const n = part.split("=")[0]?.trim();
        if (n) cookieNames.push(n);
      }
      stored = `[${cookieNames.length} cookies]`;
    } else if (lower === "authorization" || lower === "proxy-authorization") {
      stored = `${value.split(" ")[0] ?? ""} [redacted]`;
    } else if (SECRET_NAME.test(lower)) {
      stored = `[redacted len=${value.length}]`;
    } else {
      stored = value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
    }
    values[lower] = values[lower] !== undefined ? `${values[lower]}, ${stored}` : stored;
  }
  const orderHash = createHash("sha256").update(order.map((n) => n.toLowerCase()).join(",")).digest("hex").slice(0, 16);
  return { order, orderHash, values, cookieNames };
}

export interface EdgeTlsView {
  hasGrease?: boolean;
  alpnOffered?: string[];
  pseudoOrder?: string | null;
}

/**
 * Things a real browser of the claimed family would send but this request didn't (or vice versa).
 * Each flag is evidence of a script/automation wearing a browser user-agent — not proof alone.
 */
export function consistencyFlags(h: HeaderCapture, ua: UaInfo, isHttps: boolean, edge: EdgeTlsView | null): string[] {
  const flags: string[] = [];
  const v = h.values;
  const b = ua.browser;
  if (!b) return flags;
  if (!v["accept"]) flags.push("no_accept");
  if (!v["accept-language"]) flags.push("no_accept_language");
  if (!v["accept-encoding"]) flags.push("no_accept_encoding");
  else if (!/\bbr\b/.test(v["accept-encoding"])) flags.push("accept_encoding_without_br");

  if (b.chromium && isHttps) {
    if (!v["sec-ch-ua"]) flags.push("chromium_ua_without_client_hints");
    else {
      const chMajor = /"(?:Google Chrome|Chromium|Microsoft Edge|Opera)";v="(\d+)"/.exec(v["sec-ch-ua"])?.[1];
      if (chMajor && b.major && Number(chMajor) !== b.major) flags.push("client_hints_version_mismatch");
      const chPlatform = v["sec-ch-ua-platform"]?.replace(/"/g, "");
      if (chPlatform && ua.platform && chPlatform !== ua.platform) flags.push("client_hints_platform_mismatch");
    }
    if (!v["sec-fetch-mode"]) flags.push("chromium_ua_without_sec_fetch");
  }
  if ((b.family === "firefox" || b.family === "safari") && v["sec-ch-ua"]) flags.push("non_chromium_ua_with_client_hints");
  if (edge) {
    if (b.chromium && edge.hasGrease === false) flags.push("tls_not_chromium");
    if (edge.alpnOffered && !edge.alpnOffered.includes("h2")) flags.push("tls_no_h2_offered");
    if (b.chromium && edge.pseudoOrder && edge.pseudoOrder !== "m,a,s,p") flags.push("h2_pseudo_order_not_chromium");
  }
  return flags;
}
