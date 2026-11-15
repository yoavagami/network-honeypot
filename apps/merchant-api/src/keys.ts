import { ID_PATTERNS } from "@honeypot/merchant-contract";
import type { MerchantSql } from "@honeypot/merchant-db";
import { randomString } from "./ids.js";
import { sha256 } from "./crypto.js";
import { ApiFailure } from "./errors.js";

export type KeyKind = "public" | "secret";

/** New key value. Public: pk_<mode>_ + 24; secret: sk_<mode>_ + 32 (contract ID_PATTERNS). */
export function generateKey(kind: KeyKind, livemode: boolean): string {
  const mode = livemode ? "live" : "test";
  return kind === "public" ? `pk_${mode}_${randomString(24)}` : `sk_${mode}_${randomString(32)}`;
}
export const generateWebhookSecret = () => `whsec_${randomString(32)}`;

export const hashKey = (value: string) => sha256(value);
/** "sk_test_…a91F" — enough to recognise a key, useless to an attacker. */
export const displayKey = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;

export interface KeyIdentity { keyId: string; merchantId: string; livemode: boolean; kind: KeyKind }

/**
 * Resolves a key to its merchant. Throws ApiFailure with the contract's code: a malformed or
 * unknown key is invalid_key; the other kind of key is wrong_key_type; a revoked key, or a
 * merchant that isn't approved, is key_revoked.
 */
export async function authenticateKey(sql: MerchantSql, raw: string | undefined, expected: KeyKind): Promise<KeyIdentity> {
  if (!raw) throw new ApiFailure("invalid_key", expected === "secret" ? "Send your secret key as: Authorization: Bearer sk_…" : "Missing site key.");
  const looksPublic = ID_PATTERNS.siteKey.test(raw);
  const looksSecret = ID_PATTERNS.secretKey.test(raw);
  if (!looksPublic && !looksSecret) throw new ApiFailure("invalid_key", "The key is not a valid uHoney key.");
  if ((expected === "secret" && looksPublic) || (expected === "public" && looksSecret)) {
    throw new ApiFailure("wrong_key_type", expected === "secret"
      ? "This endpoint needs your secret key (sk_…), not the public site key."
      : "Never send a secret key from the browser. The tag uses the public site key (pk_…).");
  }
  const [row] = await sql<{ key_id: string; merchant_id: string; kind: KeyKind; livemode: boolean; revoked: boolean; merchant_status: string }[]>`
    SELECT * FROM mk_lookup_key(${hashKey(raw)})`;
  if (!row) throw new ApiFailure("invalid_key", "The key is not valid.");
  if (row.revoked) throw new ApiFailure("key_revoked", "This key has been revoked. Create a new one in the dashboard.");
  if (row.merchant_status !== "approved") throw new ApiFailure("key_revoked", "This merchant account is not active.");
  return { keyId: row.key_id, merchantId: row.merchant_id, livemode: row.livemode, kind: row.kind };
}

/** Reads "Authorization: Bearer <key>". */
export function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  const m = h?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1];
}
