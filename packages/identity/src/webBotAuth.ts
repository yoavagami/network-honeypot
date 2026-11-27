import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/**
 * Web Bot Auth verification (HTTP Message Signatures, RFC 9421, with the web-bot-auth
 * directory draft). A Signature-Agent header on its own is just a claim anyone can type — the
 * request only counts as signed by e.g. chatgpt.com once the signature verifies against the key
 * published in that origin's /.well-known/http-message-signatures-directory.
 *
 * The directory URL comes from the request itself (attacker-controlled), so fetching it is
 * guarded: https only, every resolved address must be public, no redirects, 3s timeout, 64 KB
 * cap, per-origin caching and a global hourly budget.
 */

export type WbaStatus =
  | "absent"
  | "malformed"
  | "verified"
  | "invalid_signature"
  | "expired"
  | "key_not_found"
  | "directory_unavailable"
  | "unsupported_alg";

export interface WbaResult {
  status: WbaStatus;
  signer: string | null;
  keyid?: string;
  tag?: string;
  alg?: string;
  created?: number;
  expires?: number;
  nonce?: string;
  components?: string[];
  error?: string;
}

export interface SignedRequest {
  method: string;
  /** Path + query as received, e.g. "/docs?x=1". */
  url: string;
  host: string;
  /** Header lookup returning every value of a (lowercase) header name. */
  header(name: string): string[];
}

// ---- Minimal structured-field parsing (just what Signature-Input / Signature / Signature-Agent use)

/** Splits a structured-field dictionary into raw `name -> serialized value` members. */
export function splitDictionary(value: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let inQuote = false;
  let inBytes = false;
  let start = 0;
  const push = (end: number) => {
    const member = value.slice(start, end).trim();
    if (!member) return;
    const eq = member.indexOf("=");
    if (eq === -1) out.set(member, "?1");
    else out.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inQuote) {
      if (c === "\\") i++;
      else if (c === '"') inQuote = false;
    } else if (inBytes) {
      if (c === ":") inBytes = false;
    } else if (c === '"') inQuote = true;
    else if (c === ":") inBytes = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(value.length);
  return out;
}

interface ParsedInput {
  /** Serialized component ids exactly as they appear, e.g. `"signature-agent";key="sig1"`. */
  components: string[];
  params: Record<string, string | number>;
  /** The inner list + params exactly as sent — this is what @signature-params signs. */
  raw: string;
}

export function parseSignatureInput(raw: string): ParsedInput | null {
  const m = /^\(([^)]*)\)(.*)$/s.exec(raw.trim());
  if (!m) return null;
  const components = [...m[1]!.matchAll(/"[^"]*"(?:;[a-z0-9*_.-]+(?:=(?:"[^"]*"|[^;\s")]+))?)*/g)].map((x) => x[0]);
  const params: Record<string, string | number> = {};
  for (const p of m[2]!.matchAll(/;([a-z0-9*_.-]+)(?:=("(?:[^"\\]|\\.)*"|[^;\s]+))?/g)) {
    const v = p[2] ?? "?1";
    params[p[1]!] = v.startsWith('"') ? v.slice(1, -1) : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return { components, params, raw: raw.trim() };
}

function unquote(s: string): string {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** The signer origin named by Signature-Agent (a bare sf-string, or a dictionary member). */
export function signerFromHeader(value: string | undefined, label?: string): string | null {
  if (!value) return null;
  const v = value.trim();
  let candidate: string | null = null;
  if (v.startsWith('"')) candidate = unquote(v);
  else {
    const dict = splitDictionary(v);
    candidate = unquote((label && dict.get(label)) || [...dict.values()][0] || "");
  }
  if (!candidate) return null;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.origin;
  } catch {
    return null;
  }
}

// ---- Signature base (RFC 9421 §2.5)

function componentValue(id: string, req: SignedRequest): string | null {
  const m = /^"([^"]*)"(.*)$/.exec(id);
  if (!m) return null;
  const name = m[1]!;
  const params = m[2]!;
  const [path, query] = req.url.split("?", 2) as [string, string | undefined];
  const authority = req.host.toLowerCase().replace(/:443$/, "");
  switch (name) {
    case "@method": return req.method.toUpperCase();
    case "@authority": return authority;
    case "@scheme": return "https";
    case "@path": return path || "/";
    case "@query": return `?${query ?? ""}`;
    case "@target-uri": return `https://${authority}${req.url}`;
    case "@request-target": return req.url;
  }
  if (name.startsWith("@")) return null;
  const values = req.header(name);
  if (values.length === 0) return null;
  const combined = values.map((v) => v.trim()).join(", ");
  const key = /;key="([^"]*)"/.exec(params)?.[1];
  if (key !== undefined) return splitDictionary(combined).get(key) ?? null;
  return combined;
}

export function signatureBase(input: ParsedInput, req: SignedRequest): string | null {
  const lines: string[] = [];
  for (const id of input.components) {
    const value = componentValue(id, req);
    if (value === null) return null;
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${input.raw}`);
  return lines.join("\n");
}

// ---- Key directory

export function jwkThumbprint(jwk: JsonWebKey): string | null {
  let canonical: string;
  if (jwk.kty === "OKP") canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  else if (jwk.kty === "EC") canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  else return null;
  return createHash("sha256").update(canonical).digest("base64url");
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
function isPublicAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(a) === 4) return !PRIVATE_V4.some((re) => re.test(a));
  return !(a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80"));
}

type Directory = { keys: JsonWebKey[] };
const directoryCache = new Map<string, { at: number; ok: boolean; dir?: Directory }>();
const DIR_TTL_OK_MS = 3600_000;
const DIR_TTL_FAIL_MS = 10 * 60_000;
let fetchBudget = { windowStart: Date.now(), used: 0 };
const MAX_FETCHES_PER_HOUR = 60;

export type DirectoryFetcher = (origin: string) => Promise<Directory | null>;

async function fetchDirectory(origin: string): Promise<Directory | null> {
  const url = new URL("/.well-known/http-message-signatures-directory", origin);
  if (url.protocol !== "https:") return null;
  const host = url.hostname;
  if (isIP(host)) {
    if (!isPublicAddress(host)) return null;
  } else {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0 || !addrs.every((a) => isPublicAddress(a.address))) return null;
  }
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(3000),
    headers: { Accept: "application/http-message-signatures-directory+json, application/json" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > 65_536) return null;
  const data = JSON.parse(text) as Directory;
  return Array.isArray(data.keys) ? data : null;
}

async function getDirectory(origin: string, fetcher: DirectoryFetcher): Promise<Directory | null> {
  const cached = directoryCache.get(origin);
  if (cached && Date.now() - cached.at < (cached.ok ? DIR_TTL_OK_MS : DIR_TTL_FAIL_MS)) return cached.dir ?? null;
  if (Date.now() - fetchBudget.windowStart > 3600_000) fetchBudget = { windowStart: Date.now(), used: 0 };
  if (fetchBudget.used >= MAX_FETCHES_PER_HOUR) return cached?.dir ?? null;
  fetchBudget.used += 1;
  let dir: Directory | null = null;
  try {
    dir = await fetcher(origin);
  } catch {
    dir = null;
  }
  if (directoryCache.size > 500) directoryCache.clear();
  directoryCache.set(origin, { at: Date.now(), ok: dir !== null, dir: dir ?? undefined });
  return dir;
}

// ---- Verification

export async function verifyWebBotAuth(
  req: SignedRequest,
  opts: { now?: number; fetcher?: DirectoryFetcher } = {}
): Promise<WbaResult> {
  const sigInput = req.header("signature-input").join(", ");
  const sigHeader = req.header("signature").join(", ");
  const agentHeader = req.header("signature-agent").join(", ") || undefined;
  if (!sigInput && !sigHeader && !agentHeader) return { status: "absent", signer: null };

  const inputs = splitDictionary(sigInput);
  const sigs = splitDictionary(sigHeader);
  // Prefer the signature tagged web-bot-auth; otherwise the first one present in both headers.
  let label: string | undefined;
  for (const [name, raw] of inputs) {
    if (!sigs.has(name)) continue;
    if (/;tag="web-bot-auth"/.test(raw)) { label = name; break; }
    label ??= name;
  }
  const signer = signerFromHeader(agentHeader, label);
  if (!label) return { status: "malformed", signer, error: "no matching Signature-Input / Signature pair" };

  const input = parseSignatureInput(inputs.get(label)!);
  const sigRaw = sigs.get(label)!;
  const sigMatch = /^:([A-Za-z0-9+/=_-]*):$/.exec(sigRaw);
  if (!input || !sigMatch) return { status: "malformed", signer, error: "unparseable signature fields" };
  const p = input.params;
  const base: WbaResult = {
    status: "malformed",
    signer,
    keyid: typeof p.keyid === "string" ? p.keyid : undefined,
    tag: typeof p.tag === "string" ? p.tag : undefined,
    alg: typeof p.alg === "string" ? p.alg : undefined,
    created: typeof p.created === "number" ? p.created : undefined,
    expires: typeof p.expires === "number" ? p.expires : undefined,
    nonce: typeof p.nonce === "string" ? p.nonce : undefined,
    components: input.components,
  };
  if (!signer) return { ...base, error: "missing or invalid Signature-Agent" };
  if (base.alg && base.alg !== "ed25519") return { ...base, status: "unsupported_alg" };

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (base.expires !== undefined && base.expires < now) return { ...base, status: "expired" };
  if (base.created !== undefined && base.created > now + 60) return { ...base, status: "expired", error: "created in the future" };

  const sigBase = signatureBase(input, req);
  if (sigBase === null) return { ...base, error: "a signed component is missing from the request" };

  const dir = await getDirectory(signer, opts.fetcher ?? fetchDirectory);
  if (!dir) return { ...base, status: "directory_unavailable" };
  const key = dir.keys.find((k) => k.kty === "OKP" && (jwkThumbprint(k) === base.keyid || (k as { kid?: string }).kid === base.keyid));
  if (!key) return { ...base, status: "key_not_found" };

  try {
    const publicKey = createPublicKey({ key: key as JsonWebKey, format: "jwk" });
    const ok = verify(null, Buffer.from(sigBase, "utf8"), publicKey, Buffer.from(sigMatch[1]!, sigMatch[1]!.includes("-") || sigMatch[1]!.includes("_") ? "base64url" : "base64"));
    return { ...base, status: ok ? "verified" : "invalid_signature" };
  } catch (err) {
    return { ...base, status: "invalid_signature", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test hook — clears the directory cache and fetch budget. */
export function resetWebBotAuthCache() {
  directoryCache.clear();
  fetchBudget = { windowStart: Date.now(), used: 0 };
}
