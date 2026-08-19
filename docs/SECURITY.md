# Security Model

## 1. Security headers

Applied by the honeypot app (public site) — chosen to look like a plausible, reasonably
security-conscious real app, not maximally locked down in a way that would itself be a
fingerprinting signal, but never weakened in a way that creates a real vulnerability:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
                          img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'
Strict-Transport-Security: max-age=15552000; includeSubDomains   (prod/TLS only)
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```
No `X-Powered-By`, no framework version leakage in any header. CORS on the public API is
same-origin only (no `Access-Control-Allow-Origin: *`) — a real product-grade API would not
casually allow arbitrary origins, and neither do we.

Admin dashboard adds a stricter CSP (no inline styles at all), plus:
```
Set-Cookie: admin_session=...; HttpOnly; Secure; SameSite=Strict; Path=/
Set-Cookie: csrf_token=...; Secure; SameSite=Strict; Path=/        (readable by JS, by design,
                                                                     for the double-submit pattern)
```

## 2. Admin authentication

- Argon2id password hashing (memory-hard, tuned parameters documented in
  `packages/db` migration comments).
- MFA-ready: `admin_users.mfa_secret` (TOTP) column exists in Phase 1 schema; enforcement toggle
  is a Phase 2/3 item once there's more than one admin operator.
- Session cookie: random 256-bit token, server-side session table (not a JWT — we want instant
  revocation capability), `SameSite=Strict`, `Secure`, `HttpOnly`, short idle timeout
  (default 30 min) + absolute lifetime (default 12h).
- CSRF: double-submit token required on all state-changing admin requests.
- Rate limiting: login attempts limited per-IP and per-username at both Nginx and app level;
  failures are audit-logged (and, notably, also flow into the *honeypot's own* detection
  taxonomy is NOT applicable here — this is the admin surface, kept fully separate).
- No default credentials anywhere in the repo or images; the seed script never creates an admin
  user with a known password — it either prompts or reads from an explicitly-set env var the
  operator must supply, and refuses to run non-interactively without one.

## 3. Isolation checklist (containers)

Applied to `honeypot` and `admin-api` Dockerfiles/compose service definitions:
- [ ] Runs as a dedicated non-root UID/GID (no `root` anywhere in the running container).
- [ ] `read_only: true` root filesystem; writable tmpfs only where genuinely needed (e.g. `/tmp`).
- [ ] `cap_drop: [ALL]`, no added capabilities.
- [ ] `security_opt: [no-new-privileges:true]`.
- [ ] No Docker socket mount, no host filesystem bind mounts (Postgres uses a named volume only).
- [ ] No cloud IAM credentials or instance-metadata reachability from the honeypot's identity.
- [ ] No SSH keys, no production secrets baked into images or env beyond what each service
      strictly needs (honeypot app never has the admin DB role or admin session-signing key).
- [ ] Each service has its own dedicated, least-privilege Postgres role (see DATA_MODEL.md +
      ARCHITECTURE.md §3).
- [ ] Outbound network egress from the honeypot app container is not required for any route
      handler and is not exercised by any code path — no HTTP client is wired into public routes.

## 4. Adversarial review checklist (run against the running Phase 1 stack before calling it done)

This is the executable version of THREAT_MODEL.md §4 — each item has a concrete test, not just a
design claim:

1. `curl` the honeypot for stack traces / framework fingerprints on malformed input → expect our
   own generic error page, `Server` header genericized.
2. Attempt SQLi/XSS/path traversal/command injection/prototype-pollution-shaped payloads against
   every form and API param → expect schema validation rejection + `SUSPICIOUS_PAYLOAD` event,
   never a raw DB error surfaced, never actual execution.
3. Attempt to reach `admin-api`/`admin-web`/Postgres ports directly from outside the `public`
   Docker network → expect connection refused (verified via `docker compose exec` port-scan
   comparison, not just config review).
4. Attempt CSRF against an authenticated admin mutation without a valid CSRF token → expect 403.
5. Attempt to flood the ingestion queue (traffic simulator burst mode) → expect
   `events_dropped_total` to rise for low-value classes only, canary/auth/admin events fully
   retained, and the honeypot app to keep responding.
6. Inspect environment/process for the honeypot container → confirm no admin credentials, no
   cloud credentials, no SSH keys present.
7. Attempt to forge `X-Forwarded-For` to spoof actor identity/geo → confirm actor correlation and
   any rate limiting are unaffected (they use Nginx-set `X-Real-IP`, not the client header).
8. Attempt to submit a fake/replayed timestamp in any request → confirm all stored timestamps are
   server-assigned.
9. Confirm no code path in `apps/honeypot` route handlers imports an outbound HTTP client.
10. Confirm `admin-api`'s Postgres role, tested directly, cannot `INSERT`/`UPDATE`/`DELETE` on
    `requests` or `events`.

Findings from running this checklist against the actual Phase 1 build are recorded at the bottom
of this file once the stack is up (see §5).

## 5. Adversarial review results (Phase 1 build)

Executed against the running Docker Compose stack (real containers, real network segmentation,
real scoped DB roles — not a design-only review). Each item from §4's checklist:

1. **Stack traces / framework fingerprints on malformed input** — PASS. Malformed JSON, invalid
   route params, and thrown errors all render the app's own branded error pages; no Fastify/Node
   stack trace or framework name ever appeared in a response body.
2. **SQLi/XSS/path-traversal/command-injection-shaped payloads** — PASS. No SQL injection surface
   exists at all in the public app (no route builds a query by string-concatenating user input;
   search/filtering is done via parameterized Drizzle queries or in-memory JS filtering). XSS
   payloads in the search query are HTML-escaped on render. Path-traversal-shaped object IDs are
   looked up in Postgres by exact string match, never used as filesystem paths. Command-injection
   payloads are treated as inert search strings (no shell invocation exists anywhere in the app).
3. **Reach admin-api/admin-web/Postgres from outside the public network** — PASS. Verified via
   `docker compose ps`: the honeypot container has **no published host port at all**
   (`PublishedPort: 0`, reachable only from Nginx over the internal Docker network); Postgres,
   admin-api, and admin-web are each bound to `127.0.0.1` only (loopback, dev-convenience —
   removed entirely in the production compose override per DEPLOYMENT.md); only Nginx binds
   `0.0.0.0`.
4. **CSRF without a valid token** — PASS. A state-changing admin-api request with cookies but no
   `X-CSRF-Token` header returns `403 csrf_failed`.
5. **Flood the ingestion queue** — PASS with a caveat found and documented, not silently accepted:
   a true-simultaneous 40-request burst was partly rejected by **Nginx's** `limit_req` zone before
   ever reaching the app (protective behavior working as designed — see docs/ARCHITECTURE.md §14's
   "never traded away" invariant). The requests that *did* reach the app were fully captured with
   zero `events_dropped_total`. The gap this surfaced — Nginx-level rejections currently produce no
   telemetry row at all — is recorded honestly in docs/ROADMAP.md as a Phase 1 known gap rather than
   glossed over, with a concrete Phase 2/3 fix (ship Nginx's JSON access log into the same pipeline).
6. **Inspect environment/process for the honeypot container** — PASS. `docker compose exec
   honeypot printenv` shows only the honeypot's own scoped `DATABASE_URL` (honeypot_role),
   `COOKIE_SECRET`, and `IP_HASH_SECRET` — no admin credentials, no `SESSION_SECRET`, no cloud
   credentials, no SSH keys.
7. **Forge `X-Forwarded-For` to spoof actor identity** — PASS. Two requests with different
   spoofed `X-Forwarded-For` values from the same real connection resolved to the **same**
   `ip_hash` in `requests` (derived from Nginx's trusted view via `trustProxy: 1`), while the
   spoofed values were recorded separately and explicitly in `forwarded_for_client_supplied`,
   never used for correlation.
8. **Submit a fake/replayed timestamp** — PASS. Every `createdAt` in the ingestion code is a
   fresh server-side `new Date()`; no request field ever maps to a stored timestamp.
9. **Outbound HTTP client in a public route handler** — PASS. `grep` across
   `apps/honeypot/src/routes/` confirms no `fetch`/`axios`/`http(s).request` call exists in any
   route handler.
10. **admin-api's DB role writing to `requests`/`events`** — PASS. Attempting an `INSERT` as
    `admin_api_role` against `events` fails with `permission denied for table events`, verified
    directly against the running database, not just read from the migration file.

### Issues found and fixed during this review (not pre-existing design gaps)

- The SSE live-stream route used `reply.hijack()` to write directly to the raw response but never
  set CORS headers itself — `hijack()` bypasses Fastify's `onSend` hook chain, which is where
  `@fastify/cors` normally adds them, so the browser silently rejected the stream cross-origin.
  Fixed by setting `Access-Control-Allow-Origin`/`-Credentials` explicitly in the hijacked
  response's headers.
- `admin-api`'s `HONEYPOT_INTERNAL_URL` had no container-network override in `docker-compose.yml`,
  so it defaulted to `http://localhost:8080` — inside the admin-api container that's its own
  loopback, not the honeypot container, so `/api/system/ingestion` always failed. Fixed by setting
  it to `http://honeypot:8080` (Docker service DNS) in compose.
- `actors.unique_paths` was defined in the schema and shown on the dashboard but nothing ever
  wrote to it. Fixed in the correlation worker (approximated from the in-memory correlation
  window, not a lifetime count — documented in code as a scoped approximation).
- The generic 500 error page hardcoded the text "500" even when the actual response was a 4xx
  (e.g. malformed JSON body → 400). Fixed to render the real status code.
- The public and admin-facing Nginx/Nginx-served containers (`nginx`, `admin-web`) failed to
  start under `cap_drop: [ALL]` + `read_only: true` because the stock image tries to `chown` its
  temp/cache directories as root before dropping privileges. Fixed by running both containers
  directly as the image's non-root `nginx` user (`101:101`, skipping the root phase entirely) and
  giving their tmpfs cache/run mounts an explicit writable mode.
