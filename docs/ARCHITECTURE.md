# Architecture

## 1. Goals, restated as design constraints

1. **Realistic** — a visitor (human or automated) should not be able to trivially fingerprint this
   as a honeypot from the outside.
2. **Observable** — every meaningful interaction produces a structured event, and event loss under
   load is itself an alertable condition.
3. **Isolated** — compromise of the public-facing app must not yield: host access, database
   credentials beyond its own scoped role, telemetry tampering, or a pivot point into anything else.
4. **Purely defensive** — no code path sends traffic *to* a visitor's infrastructure, ever.
5. **Boring where it matters** — the ingestion path, storage, and admin auth are the least
   experimental parts of the system. Deception content is where we spend creative effort.

## 2. Technology decisions

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20) everywhere | One language across honeypot app, admin API, dashboard, and shared detection/type packages. Reduces the chance of subtle logic drift between "what the honeypot recorded" and "what the dashboard assumes the schema looks like" — both import the same `packages/types`. |
| Honeypot app framework | Fastify | Low overhead, first-class schema validation (we validate *every* inbound request against a schema so malformed input is itself a clean, typed signal rather than an unhandled exception that leaks a stack trace). |
| Admin API framework | Fastify (separate process/deployment from the honeypot app) | Same ergonomics; kept as a **separate app**, not a route namespace on the honeypot, so a honeypot-app compromise does not automatically expose admin route handlers or its DB role. |
| Dashboard | React + Vite + TypeScript, Tailwind, TanStack Query/Table, Recharts | SPA is appropriate here — it's an internal tool, not something that needs SSR/SEO. Vite keeps the build simple. |
| Database | PostgreSQL 16 | Strong indexing, native partitioning for the high-volume tables, JSONB for flexible header/metadata capture without losing the ability to index the structured columns. Matches the spec's explicit preference. |
| ORM / migrations | Drizzle | Typed schema-as-code, explicit SQL-visible migrations (no magic), works well with partitioned tables. |
| Event transport (Phase 1) | In-process bounded async queue, batch-flushed to Postgres | Simplest thing that decouples request latency from DB write latency and survives traffic bursts without a new infra dependency. See §6. |
| Event transport (Phase 5, conditional) | Redis Streams or NATS | Only introduced if we need >1 honeypot app instance writing to a shared ingestion pipeline. Not built until traffic demands it. |
| Reverse proxy | Nginx | Mature, well-understood access logging, connection/rate limiting, TLS termination. |
| Realtime to dashboard | Server-Sent Events | One-directional (server → browser) is all the live stream needs; simpler than WebSockets, plays nicer with Nginx/proxy buffering, trivially reconnects. |
| Containerization | Docker Compose (Phase 1–4), no Kubernetes | A single hardened host running Compose is the right complexity level for this traffic profile and threat model. Kubernetes would add an orchestration attack surface and operational burden with no corresponding benefit at this scale — revisit only if we need multi-host horizontal scaling of the honeypot app itself. |

## 3. Network / ingress architecture

```
                              Internet
                                 |
                          Public IP : 443/80
                                 |
                         +---------------+
                         |     Nginx     |   (public network)
                         | TLS terminate |
                         | access log    |
                         | rate/conn lim |
                         +-------+-------+
                                 |
                                 v
                       +-------------------+
                       |  honeypot app     |   (public + internal network)
                       |  (Fastify)        |
                       |  non-root, RO fs  |
                       +---------+---------+
                                 |  scoped DB role: honeypot_writer
                                 |  (INSERT-only on requests/events/canary_events,
                                 |   SELECT on a narrow set of read views it needs
                                 |   for deception continuity, e.g. "does this
                                 |   session already have a synthetic user")
                                 v
                       +-------------------+
                       |   PostgreSQL      |   (internal network only — never
                       |                   |    bound to a public interface)
                       +---------+---------+
                                 ^  scoped DB role: admin_reader (+ narrow writer
                                 |  for admin_audit_log / detection ack state)
                       +-------------------+
                       |   admin-api       |   (internal + admin network)
                       |   (Fastify)       |
                       +---------+---------+
                                 |
                                 v
                       +-------------------+
                       |   admin-web       |   (admin network only, NOT on the
                       |   (static SPA)    |    public Nginx vhost/port)
                       +-------------------+
```

Three Docker networks:
- **public** — Nginx + honeypot app only. This is the only network with a published port to the host.
- **internal** — honeypot app + admin-api + Postgres. Postgres has *no* published port; only
  reachable from containers on this network.
- **admin** — admin-api + admin-web. In Phase 1 this is exposed on a separate host port for local
  use; in Phase 4 it moves behind a VPN/allowlist/IAP and is never reachable from the public
  Internet directly (see DEPLOYMENT.md).

The honeypot app and admin-api are **separate services with separate DB roles and separate
containers**, specifically so that an RCE in the honeypot app (which is the thing we're
deliberately exposing to attackers) does not hand the attacker the admin session-signing key,
the admin DB role, or the audit log.

## 4. Request lifecycle (the ingestion path)

1. Nginx receives the request, terminates TLS, assigns/propagates a request ID
   (`X-Request-Id`), logs the raw access line, applies connection/rate limits, forwards to the
   honeypot app with `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP` set explicitly (Nginx
   overwrites/sets these itself — it does not trust an inbound `X-Forwarded-For` from the client
   as the source IP; see §9 on trust boundaries).
2. The honeypot app's request hook fires **before** route handling:
   - normalizes and hashes the client IP (`ip_hash = HMAC(IP, daily_salt)`), never stores raw IP
     beyond `RAW_IP_RETENTION_DAYS`.
   - resolves/creates a `visitor_id` cookie (opaque, random, HttpOnly, not tied to auth) and a
     `session_id`.
   - buffers request metadata (method, path, query keys, headers allowlist, sizes, timing) into
     an in-memory event object. Bodies are *never* logged verbatim; only size, content-type, and
     (for JSON) a redacted key-shape summary (see DATA_MODEL.md §Redaction).
3. The route handler runs (serves the deceptive page/API response) and, on completion, the
   response hook finalizes the event: status code, response size, duration, and the
   `application_component`/`endpoint` tag the handler declared.
4. The finalized event is pushed onto the in-process bounded queue (§6). The HTTP response is
   already sent by this point — ingestion never adds latency to the visitor-facing response.
5. The detection engine runs in two places:
   - **inline, cheap checks** (static path/UA/header rules) run synchronously before the event is
     queued, because they're O(1) and cheap enough not to matter, and they let us tag
     `HONEYPOT_TRIGGER`/`SUSPICIOUS_*` on the event itself.
   - **correlation checks** (enumeration sequences, login velocity, fuzzing volume) run in a
     background worker on a short interval against recently-flushed rows, because they need
     cross-request state that's cheaper to compute from the DB (or a small in-memory per-actor
     ring buffer) than to recompute per-request.
6. The queue worker batches (by count or time, whichever comes first) and does a single
   multi-row `INSERT` per flush.

## 5. Why an in-process queue instead of Kafka/Redis for Phase 1

Trade-off, made explicit:

- **Pros of in-process queue**: zero extra infrastructure, zero extra failure mode to operate,
  trivial to reason about, sufficient for a single honeypot app instance handling bursty but
  bounded traffic (design target: sustain 1,000 req/s of *event production* without dropping
  events — see PERFORMANCE section in DEPLOYMENT.md for the actual tested number).
  - Backpressure: if the queue is full (bounded ring buffer), we **drop the lowest-value event
    class first** (plain `HTTP_REQUEST` on an already-well-observed static asset) before ever
    dropping a `CANARY_TRIGGERED`, `LOGIN_ATTEMPT`, or `ADMIN_PAGE_ACCESS` event, and we
    increment `events_dropped` so it's visible in the health metrics (see §11). We do not silently
    lose high-value events under load if we can help it.
- **Cons**: events live only in one process's memory between generation and flush — a hard crash
  of the honeypot app can lose the last unflushed batch (bounded to a few hundred ms of traffic by
  the flush interval). Doesn't horizontally scale past one honeypot app instance without shared
  state.
- **When to graduate to Redis Streams/NATS (Phase 5)**: when we need >1 honeypot app instance
  (for either capacity or availability), or when we want ingestion to survive a full process crash
  with zero event loss. The producer interface (`packages/detection`'s event emitter) is already
  written against an abstract `EventSink`, so this swap does not touch application code.

## 6. Application architecture

### Honeypot app (`apps/honeypot`)
- Server-rendered pages (Eta templates) for the "human-facing" site: home, login, register,
  password reset, profile, search, docs/API reference, admin-looking area, error pages.
- A JSON API surface under `/api/v1/*` mirroring what a real SaaS app would expose (users,
  objects/files, search, config, health) — this is what scanners/API tools/LLM agents will find
  and probe.
- Every route module declares its `applicationComponent` and expected schema; unmatched
  routes/methods fall through to a single deceptive 404/405 handler that still emits a full event
  (`INVALID_ROUTE`/`INVALID_METHOD`) rather than Fastify's default.
- Deceptive state is real but scoped: e.g. a "login" can succeed against a *synthetic* seeded user
  and issue a real-looking session cookie that is meaningless outside this app (signed with a key
  that has no relationship to anything else, rotated independently).

### Admin API (`apps/admin-api`)
- Cookie-session auth (Argon2id password hashing), CSRF double-submit token, strict CORS (only the
  admin-web origin), audit log on every authenticated action.
- REST endpoints per `docs/API.md`, plus `/api/stream` (SSE) for the live event feed.
- Talks to Postgres with a role that can read broadly but write only to `admin_audit_log` and
  `detections.acknowledged_*` columns — it cannot write into `requests`/`events`, so a bug in the
  admin API can't be used to forge honeypot telemetry.

### Admin dashboard (`apps/admin-web`)
- Static SPA, built once, served by a minimal static file server (or Nginx on the admin network,
  separate config from the public vhost). Talks only to `admin-api`.

## 7. Actor correlation model

We deliberately do **not** treat `IP = actor`. `actor_id` is a probabilistic cluster key:

1. Compute a set of *signals* per request: `ip_hash`, coarse UA fingerprint (family + major
   version, not the raw string, though the raw string is also stored separately for display),
   `visitor_id` cookie, TLS/HTTP version tuple, Accept-Language.
2. An actor record is created/matched by: exact `visitor_id` cookie match first (strongest
   signal — same browser/client instance) → else `ip_hash + UA fingerprint` match within a
   rolling window → else new actor.
3. Every additional IP/UA/session seen against the same `visitor_id` is appended to that actor's
   history rather than spawning a new actor; every time we merge signals we recompute a
   **confidence label** (High/Medium/Low) from signal agreement — never presented as certainty.
4. The dashboard always shows the signal basis for an actor's identity, not just a conclusion.

## 8. TLS / HTTP fingerprinting

Records what Nginx can see without extra modules: negotiated TLS version/cipher (via
`$ssl_protocol`/`$ssl_cipher`), ALPN, and HTTP version — all logged as **observed facts**, passed
from Nginx to the app as headers (`X-TLS-Version`/`X-TLS-Cipher`/`X-ALPN-Protocol`, set only by
Nginx, trusted the same way `X-Real-IP` is — see §9) and stored on `requests.tls_version` /
`tls_cipher` / `alpn`. Verified end-to-end against a real (self-signed, for local testing) TLS
connection in Phase 3 — the schema columns existed since Phase 1 but were unpopulated
(`null` hardcoded in capture.ts) until this was actually wired up.

JA3/JA4 (which requires seeing the raw ClientHello) is a materially bigger lift than the above —
it needs either Nginx's stream-layer SSL preread plus a JA3-computing component (Nginx itself
doesn't compute the fingerprint hash, `ssl_preread` only exposes SNI/ALPN/protocol) or a dedicated
TLS-fingerprinting proxy in front of Nginx. Deferred, not attempted partially: still not
implemented, and nothing in the data model or UI claims otherwise. Anything derived from the
facts that *are* captured (e.g. "looks like a Python TLS stack") is always labeled `inference`,
never `fact`.

## 9. Trust boundaries — headers

`X-Forwarded-For` and similar headers are attacker-controlled input, not truth. Nginx sets
`X-Real-IP` from its own view of the TCP connection and only appends to `X-Forwarded-For` (never
blindly forwards a client-supplied value as the sole source of truth). The application trusts
`X-Real-IP` as set by Nginx (a boundary the honeypot app doesn't cross, since only Nginx is
allowed to write it — the app is not internet-facing directly). Any client-supplied
`X-Forwarded-For` is still recorded (it's useful telemetry — attackers sometimes reveal internal
proxy chains or forget to strip it) but explicitly labeled `client_supplied`, never used for
IP-based logic (rate limiting, geo, actor correlation).

## 10. Network-level visibility beyond Nginx — trade-offs

| Option | What it adds | Cost | Phase 1 decision |
|---|---|---|---|
| Nginx access/error logs | HTTP-layer visibility, already needed | ~free | **Yes**, primary observation point |
| OpenTelemetry (app traces) | Cross-service request tracing | Moderate — new collector to run/secure | Deferred to Phase 3, useful once there are more than 2 services |
| eBPF connection telemetry | Raw TCP/connection-level visibility, survives app-layer evasion | High — kernel-level tooling, needs care in a container host | Phase 3, opt-in, only if host-level visibility becomes a real gap |
| Zeek | Rich network protocol analysis | High — separate always-on service watching the host's NIC | Not planned; overkill for an HTTP(S)-only honeypot; revisit only if we add non-HTTP services |
| JA3/JA4 | TLS client fingerprinting | Moderate — needs stream-layer preread or sidecar | Phase 3 |

Phase 1 conclusion: **Nginx + application-layer events already answer the vast majority of the
questions in the success-criteria list** (§53 of the brief). We add network-layer depth only when
a concrete question needs it, not by default.

## 11. Observability of the observability system

Health metrics exposed at `/internal/metrics` (internal network only, scraped by nothing external
in Phase 1 — a human/curl checks it, or Phase 3 wires up Prometheus):

```
events_received_total
events_processed_total
events_dropped_total{reason}
events_failed_total{reason}
queue_depth
queue_capacity
db_write_latency_ms (p50/p95/p99)
db_pool_in_use / db_pool_size
requests_per_second
ingestion_lag_ms          # time between event creation and DB flush
last_successful_flush_at
```

`events_dropped_total` climbing, or `last_successful_flush_at` going stale, is exactly the
"100,000 requests but 5,000 recorded" failure mode called out in the brief — Phase 1 makes it
visible on the dashboard's Overview page as a banner, not buried in logs.

## 12. Failure modes and behavior under them

| Failure | Behavior |
|---|---|
| Postgres unreachable | Honeypot app keeps serving deceptive responses (deception must not depend on the DB being up for read-mostly content); queue keeps buffering up to its cap, then starts dropping low-value events first and increments `events_dropped_total`; admin dashboard shows a health banner. |
| Queue full (extreme burst) | Drop lowest-value event classes first (see §5); never crash the request path to protect ingestion. |
| Admin API down | No effect on the public honeypot — separate process/container. |
| Nginx misconfigured rate limit hit | Attacker gets a real 429 (itself useful signal, logged) rather than the app falling over. |
| Disk fills (event volume) | Retention cron + partition-drop is the primary defense (DATA_MODEL.md); a full-disk guard also flips ingestion to "counts only" mode (increment counters, skip full event body) rather than crashing. |

## 13. Backup / recovery

- Nightly `pg_dump` (logical) of the full database to encrypted storage off the honeypot host,
  retained per `docs/DATA_MODEL.md` retention windows.
- Schema migrations are the source of truth for structure — recovery is "restore latest dump,
  replay any migrations newer than the dump."
- Admin credentials and signing secrets are **not** in the backup (they live in the deployment's
  secret store / `.env`, provisioned separately) — a stolen backup does not grant admin access.

## 14. Performance targets and scaling posture

See DEPLOYMENT.md for tested numbers. Design targets:

| Load | Expectation |
|---|---|
| 10 req/s | Trivial; full fidelity. |
| 100 req/s | Full fidelity, no dropped events, comfortable headroom. |
| 1,000 req/s | Full fidelity is the Phase 1 target; verified via `scripts/simulate-traffic.ts` + a load-test pass. |
| 10,000 req/s | Nginx connection/rate limits engage; honeypot app sheds low-value event detail before it sheds availability; this is the point at which Phase 5 (queue swap, horizontal scale) becomes necessary for full fidelity — until then, the invariant that holds is **the host and internal network stay safe**, even if some telemetry fidelity is traded away. |

The one invariant that is never traded away, at any load: **the honeypot must not become capable
of compromising its own host or reaching anything outside its declared network boundaries.**
