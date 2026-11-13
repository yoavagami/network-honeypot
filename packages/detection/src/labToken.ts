import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed lab links. `?lab=<token>` with token = `<label>~<expiresUnix>~<sig>` marks a browser as a
 * controlled test run we started ourselves (ground truth). sig = first 22 chars of base64url
 * HMAC-SHA256(secret, "<label>~<expiresUnix>"). The secret (LAB_LINK_SECRET) is shared by the
 * honeypot (verifies) and admin-api (mints) only.
 *
 * An unsigned `?lab=<label>` is still recorded, as a *claimed* label: useful when browsing the
 * data, never used as ground truth (training, the release gate, known clusters), because any
 * visitor can type it.
 */

export const LAB_LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN_RE = /^([A-Za-z0-9._-]{1,64})~(\d{9,11})~([A-Za-z0-9_-]{22})$/;
/** Longest a minted link may live. */
export const LAB_LINK_MAX_TTL_S = 30 * 24 * 3600;

export interface LabIdentity {
  label: string;
  verified: boolean;
  /** Unix seconds; only for verified tokens. */
  expiresAt?: number;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 22);
}

export function signLabToken(label: string, expiresAtUnix: number, secret: string): string {
  if (!LAB_LABEL_RE.test(label)) throw new Error("invalid lab label");
  if (!secret) throw new Error("LAB_LINK_SECRET is not set");
  const payload = `${label}~${Math.floor(expiresAtUnix)}`;
  return `${payload}~${sign(secret, payload)}`;
}

/**
 * Reads a `?lab=` value or `hp_lab` cookie. Returns a verified identity for a valid, unexpired
 * token; a claimed (unverified) identity for a bare label, or for a token that fails
 * verification (its label part); null for anything else.
 */
export function parseLabValue(value: unknown, secret: string | undefined, nowMs: number = Date.now()): LabIdentity | null {
  if (typeof value !== "string" || value.length > 120) return null;
  const m = TOKEN_RE.exec(value);
  if (m) {
    const [, label, exp, sig] = m as unknown as [string, string, string, string];
    const expiresAt = Number(exp);
    if (secret) {
      const expected = Buffer.from(sign(secret, `${label}~${exp}`));
      const got = Buffer.from(sig);
      if (expected.length === got.length && timingSafeEqual(expected, got) && expiresAt * 1000 > nowMs) {
        return { label, verified: true, expiresAt };
      }
    }
    return { label, verified: false };
  }
  return LAB_LABEL_RE.test(value) ? { label: value, verified: false } : null;
}
