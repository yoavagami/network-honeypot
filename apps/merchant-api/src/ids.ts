import { createHash, randomInt } from "node:crypto";
import { CROCKFORD } from "@honeypot/merchant-contract";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform random string from an alphabet (crypto.randomInt — no modulo bias). */
export function randomString(length: number, alphabet = ALNUM): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export const newMerchantId = () => `mer_${randomString(8, CROCKFORD)}`;
export const newAssessmentId = () => `as_${randomString(20)}`;
export const newEventId = () => `evt_${randomString(20)}`;

/** Stable public id for a visit, derived from the scorer's internal visit key. */
export function visitIdFor(merchantId: string, internalKey: string): string {
  const digest = createHash("sha256").update(`${merchantId}:${internalKey}`).digest();
  let out = "";
  for (let i = 0; i < 20; i++) out += ALNUM[digest[i]! % ALNUM.length];
  return `vis_${out}`;
}
