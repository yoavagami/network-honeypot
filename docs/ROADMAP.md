# Roadmap — The End Plan

This is the phased build plan for the honeypot platform. Each phase is designed to be independently
shippable and safe to run publicly at the point it's completed. We do not move to a later phase by
skipping isolation/security work in an earlier one.

Status legend: `[x]` done, `[~]` partially done / stubbed with a real extension point, `[ ]` not started.

## Phase 0 — Design & Threat Model (this session)
- [x] Architecture, threat model, data model, detection strategy, API spec, attack-surface matrix, privacy doc.
- [x] Technology decisions with rationale.
- [x] Repository structure.

## Phase 1 — Foundation + Deception + Detection + Dashboard (POC, this session)
Goal: a fully working, locally-runnable system that proves the whole loop —
**request → capture → detect → correlate → store → visualize** — end to end.

- [x] Postgres schema + migrations (actors, sessions, requests, events, detections, canary_objects,
      canary_events, synthetic_objects, admin_users, admin_audit_log).
- [x] Shared event taxonomy + zod schemas (`packages/types`).
- [x] Structured logger with redaction (`packages/logging`).
- [x] Detection & risk-scoring engine as pure, unit-tested functions (`packages/detection`).
- [x] Honeypot public app (`apps/honeypot`): homepage, login, register, password reset, profile,
      search, docs, fake API (`/api/v1/*`), fake admin area, fake config/health endpoints,
      robots.txt, sitemap.xml, realistic 404/500 pages, file/object endpoints with IDOR-shaped IDs,
      synthetic canary tokens embedded in believable places.
- [x] Async batched event ingestion (in-process queue → batch insert), so DB writes never block
      the request path.
- [x] Actor correlation (IP hash + UA fingerprint + cookie linkage) with confidence scoring.
- [x] Admin API (`apps/admin-api`): authenticated, session-cookie + CSRF, audit-logged, SSE live
      stream, REST endpoints per `docs/API.md`.
- [x] Admin dashboard (`apps/admin-web`): overview, live event stream, event detail, actor profile +
      timeline, search, basic analytics charts.
- [x] Nginx reverse proxy in front of the honeypot only, with full request logging and the admin
      surface kept off the public vhost.
- [x] Docker Compose for local/single-VPS deployment; non-root containers; network segmentation
      (public / internal / admin).
- [x] Seed script for synthetic users, documents/invoices, and canary objects (API key, internal
      URL, admin token). Synthetic organizations are not modeled as a distinct object in Phase 1
      (each user carries a `role`, not an org membership) — add if a scenario needs it.
- [x] Attacker-traffic simulator (`scripts/simulate-traffic.ts`) exercising recon, enumeration,
      auth-probing, fuzzing, and canary triggers.
- [x] Unit tests (detection, redaction, actor correlation) + integration tests (ingestion → DB →
      API) + a smoke e2e pass.
- [x] Self-adversarial review pass against the checklist in `docs/SECURITY.md` §Adversarial Review.

**What Phase 1 deliberately stubs, not fakes:** these are real, typed interfaces with a
documented contract, wired to a clearly-labeled no-op implementation — not TODO comments.
- GeoIP/ASN enrichment: `packages/detection/src/enrichment.ts` defines the `EnrichmentProvider`
  interface and ships the `noopEnrichmentProvider` (always returns null, matching
  `GEOLOCATION_ENABLED=false` default). Nothing calls it yet — wiring it into the request path
  and swapping in a real provider (MaxMind GeoLite2, ipinfo.io) is Phase 2.
- Alert delivery: `ALERT_TRIGGERED` exists in the event taxonomy as a reserved slot; **no
  threshold-evaluation logic exists yet** — this is groundwork, not a working feature. Phase 2
  implements the actual threshold rules (per docs/ARCHITECTURE.md §36 examples) and delivery
  adapters (Slack/email/webhook) together, since a threshold with nowhere to deliver isn't useful.
- JA3/JA4 TLS fingerprinting: requires TLS termination visibility Nginx doesn't expose by default;
  documented in `docs/ARCHITECTURE.md` §TLS Fingerprinting with the `nginx-ssl-passthrough` +
  `ja4` module path for Phase 3.
- **Known Phase 1 gap, found during load testing**: Nginx's own JSON access/error logs (structured,
  request-ID-correlated per `infrastructure/nginx/nginx.conf`) are *not yet ingested* into the
  events pipeline — they're real and inspectable via `docker compose logs nginx`, but a request
  Nginx rejects before it reaches the honeypot app (e.g. `limit_req` returning 503 under burst
  load) currently produces **no row in `requests`/`events`**, only a Nginx log line. This means a
  sufficiently bursty scanner can be *partially* invisible to the dashboard even though Nginx
  itself handled it safely. Phase 2/3 fix: ship Nginx's JSON access log into the same ingestion
  path (a small log-tailing sidecar is enough at this volume — no need for a full ELK/Loki stack).

## Phase 1 self-review: reproducing the gap above

Running `pnpm simulate`'s scanner-burst persona (40 concurrent requests) against the local stack
showed Nginx's `hp_general` zone (`rate=20r/s burst=40 nodelay`) correctly rejecting a portion of
the burst with 503 — protective behavior working exactly as designed (docs/ARCHITECTURE.md §14's
"never traded away" invariant held) — but those rejected requests are the ones missing from the
dashboard per the gap above. Confirmed via `docker compose logs nginx`, which shows the 503s that
`requests`/`events` do not.

## Phase 2 — Intelligence & Analytics
- [ ] Real GeoIP/ASN enrichment (MaxMind GeoLite2 or ipinfo.io), async + cached.
- [ ] Discovery funnel analytics (homepage → robots → API → auth → canary).
- [ ] Attack-path visualization (per-actor directed graph of endpoints touched, in order).
- [ ] Bot/agent classification model v1 (rule-weighted, documented confidence, not "AI-detected" as fact).
- [ ] Alert delivery adapters: webhook, Slack, email; per-rule threshold configuration UI.
- [ ] "First contact" analytics (time-to-first-* metrics) surfaced in the dashboard.

## Phase 3 — Network-Level Visibility & Hardening
- [ ] JA3/JA4 TLS fingerprinting via Nginx stream module or a TLS-terminating sidecar that exposes
      the handshake metadata to the app.
- [ ] Optional eBPF/Zeek-based connection telemetry, evaluated as an opt-in extra (see
      ARCHITECTURE.md §Network-Level Visibility trade-offs) — not required for core value.
- [ ] Container hardening pass: read-only root filesystems everywhere, seccomp profile, capability
      drop audit, admin network fully isolated behind a VPN/IAP entry point.
- [ ] Rate limiting and connection limits tuned from real observed traffic.
- [ ] Backup/restore drill executed end-to-end (not just documented).

## Phase 4 — Public Deployment
- [ ] Hardened VPS provisioning runbook executed (firewall, SSH hardening, unattended upgrades).
- [ ] TLS via Let's Encrypt, HSTS, real domain.
- [ ] Admin dashboard placed behind an access layer (VPN, Tailscale, or IP allowlist) — never on
      the public vhost.
- [ ] Monitoring of the monitoring: ingestion-health metrics + dead-man's-switch alert if events
      stop flowing.
- [ ] Retention cron jobs running on schedule, verified against `RAW_IP_RETENTION_DAYS` etc.
- [ ] Public deployment security checklist (docs/DEPLOYMENT.md) fully checked off.

## Phase 5 — Scale & Extensibility
- [ ] Swap in-process batch queue for Redis Streams (or NATS) if sustained traffic requires
      multi-instance honeypot app instances.
- [ ] Postgres partitioning of `requests`/`events` by time (designed in Phase 1, activated when
      volume warrants it — see DATA_MODEL.md).
- [ ] Horizontal scaling of the honeypot app behind Nginx upstream pool.
- [ ] Pluggable detection rule packs (load additional heuristics without redeploying core).
- [ ] Additional deception surfaces: file upload sandbox, additional fake integrations, more
      synthetic org/user variety, localized content.

## How to pick up where this leaves off
Each unchecked item above has enough detail in the linked doc section to implement without
re-deriving the design. Start a session with: "implement Phase 2 GeoIP enrichment" and the
enrichment interface + doc section is the contract to build against.
