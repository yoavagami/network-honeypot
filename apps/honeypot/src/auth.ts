import argon2 from "argon2";

/** Argon2id hashing for synthetic honeypot account credentials. These accounts never grant
 * access to anything real — see docs/THREAT_MODEL.md — but we hash them correctly anyway
 * because that's the realistic, correct behavior we're modeling. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
