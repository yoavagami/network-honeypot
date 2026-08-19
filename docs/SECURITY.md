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

_Populated after the local stack is running and the checklist above is executed — see the final
summary in this session's work log / commit history rather than duplicating it here prematurely._
