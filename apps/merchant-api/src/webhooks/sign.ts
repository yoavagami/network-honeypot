import { hmacHex, safeEqual } from "../crypto.js";

/** Uhoney-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256("<t>.<body>", whsec_…)> (contract). */
export function signatureHeader(secret: string, body: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${hmacHex(secret, `${nowSec}.${body}`)}`;
}

/** What a merchant's handler does — used by the snippets and tests. Tolerance: 5 minutes. */
export function verifySignature(secret: string, body: string, header: string | undefined, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  const m = header?.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(m[2]!, hmacHex(secret, `${t}.${body}`));
}
