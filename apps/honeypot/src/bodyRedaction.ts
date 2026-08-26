/**
 * General request body capture — two independent safety layers, matching the redaction
 * philosophy this app already uses for headers (index.ts's Fastify logger `redact` config):
 *   1. Route-level exclusion (EXCLUDED_BODY_PATHS) — credential-bearing forms never get their
 *      body captured at all, full stop. No redaction logic is trusted alone to protect these.
 *   2. Field-name redaction (redactSensitiveFields) — for every other route, any field whose
 *      *key* looks sensitive gets its *value* replaced, key name left visible.
 * See docs/PRIVACY.md.
 */

export const EXCLUDED_BODY_PATHS = new Set(["/login", "/register", "/reset-password", "/admin/login"]);

const SENSITIVE_KEY_PATTERN = /password|pwd|pass|secret|token|api[_-]?key|credit[_-]?card|cvv|ssn|social[_-]?security/i;

const MAX_BODY_BYTES = 4096;

export function shouldCaptureBody(path: string): boolean {
  return !EXCLUDED_BODY_PATHS.has(path);
}

function redactSensitiveFields(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : value;
  }
  return result;
}

/** Returns a capture-ready, size-bounded, redacted body, or null if there's nothing worth
 * storing (no body, not a plain object, or the route is excluded entirely). */
export function prepareRequestBody(path: string, body: unknown): Record<string, unknown> | null {
  if (!shouldCaptureBody(path)) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const redacted = redactSensitiveFields(body as Record<string, unknown>);
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= MAX_BODY_BYTES) return redacted;

  // Oversized — truncate rather than drop entirely, same reasoning as capping the SQLi response
  // sample: bounded storage, one large payload shouldn't become an outlier row.
  return { truncated: true, preview: serialized.slice(0, MAX_BODY_BYTES) };
}
