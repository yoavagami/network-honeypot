import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hmacHex = (secret: string, s: string) => createHmac("sha256", secret).update(s).digest("hex");
export const hmacB64url = (secret: string, s: string) => createHmac("sha256", secret).update(s).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Per-merchant keyed IP hash: groups a visitor's events without keeping the IP. */
export const ipHash = (secret: string, merchantId: string, ip: string) => hmacHex(secret, `${merchantId}|${ip}`).slice(0, 32);

/** AES-256-GCM, output "v1.<iv>.<tag>.<ciphertext>" (base64url). */
export function encrypt(keyHex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(keyHex: string, blob: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("bad ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
