/**
 * Redaction helpers — applied at capture time, not just at retention time.
 * See docs/DATA_MODEL.md §5.
 */

const NEVER_LOG_KEYS = new Set([
  "password",
  "pass",
  "pwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credit_card",
  "ssn",
]);

export function lengthBucket(len: number): string {
  if (len <= 0) return "0";
  if (len <= 7) return "1-7";
  if (len <= 11) return "8-11";
  if (len <= 15) return "12-15";
  if (len <= 23) return "16-23";
  if (len <= 31) return "24-31";
  return "32+";
}

export function passwordShape(password: string) {
  return {
    lengthBucket: lengthBucket(password.length) as
      | "0"
      | "1-7"
      | "8-11"
      | "12-15"
      | "16-23"
      | "24-31"
      | "32+",
    hasDigit: /\d/.test(password),
    hasSymbol: /[^a-zA-Z0-9]/.test(password),
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
  };
}

/**
 * Reduce a JSON body to a key-shape summary: key names, value types, length buckets.
 * Never returns the actual values, except that key *names* are retained since they're
 * structural, not secret. `password`-shaped keys are always dropped to a boolean presence flag.
 */
export function bodyShape(body: unknown): { keys: Array<{ name: string; type: string; lengthBucket?: string }>; byteLength: number } {
  const byteLength = Buffer.byteLength(JSON.stringify(body ?? {}), "utf8");
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { keys: [], byteLength };
  }
  const keys = Object.entries(body as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      if (NEVER_LOG_KEYS.has(name.toLowerCase())) {
        return { name, type: "string", lengthBucket: "present" };
      }
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const entry: { name: string; type: string; lengthBucket?: string } = { name, type };
      if (typeof value === "string") entry.lengthBucket = lengthBucket(value.length);
      return entry;
    });
  return { keys, byteLength };
}

const ALLOWED_HEADERS = new Set([
  "user-agent",
  "accept",
  "accept-language",
  "accept-encoding",
  "referer",
  "origin",
  "content-type",
  "content-length",
  "host",
  "connection",
  "x-requested-with",
]);

/**
 * Split inbound headers into an allowlisted, verbatim-safe set and a bounded summary of
 * anything outside the allowlist (names + count only, capped).
 */
export function redactHeaders(headers: Record<string, string | string[] | undefined>) {
  const allowed: Record<string, string> = {};
  const unusualNames: string[] = [];
  let headerCount = 0;
  for (const [key, value] of Object.entries(headers)) {
    headerCount += 1;
    const lower = key.toLowerCase();
    if (lower === "cookie" || lower === "authorization" || lower === "set-cookie") continue;
    if (ALLOWED_HEADERS.has(lower)) {
      allowed[lower] = Array.isArray(value) ? value.join(", ") : value ?? "";
    } else if (unusualNames.length < 10) {
      unusualNames.push(lower);
    }
  }
  return { allowed, headerCount, unusualNames };
}

/** Cookie metadata only — names and count, never values (except our own opaque session id). */
export function redactCookies(cookies: Record<string, string>) {
  const names = Object.keys(cookies);
  return {
    count: names.length,
    names,
    hasSessionCookie: names.includes("hp_session"),
  };
}
