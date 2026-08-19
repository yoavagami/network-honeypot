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
- [x] Real GeoIP/ASN enrichment: ipinfo.io provider (`packages/detection/src/providers/ipinfo.ts`,
      unit tested against mocked responses — ASN/org parsing, non-ok/network-failure handling).
      Wired into the honeypot's request path as fire-and-forget (never awaited before the
      response), cached at actor granularity (enriched once per actor per process lifetime, not
      per request) to respect the free tier's rate limit. New `/api/analytics/geography` +
      dashboard page (requests by country/ASN, with per-group avg/max risk). Off by default
      (`GEOLOCATION_ENABLED=false`); requires the operator's own free ipinfo.io token — verified
      the disabled-by-default path end-to-end (migration applied, full stack rebuilt/redeployed,
      confirmed `enrichmentActive: false` and nothing else broke), **not** verified against a
      real ipinfo.io account/token since that requires signing up for one.
- [x] Discovery funnel analytics: `/api/analytics/discovery-funnel` + Overview dashboard panel.
      Deliberately stage-*membership*, not a strict enforced sequence (an actor counts for
      "explored the API" whether or not they hit the homepage first) — documented in the UI
      itself so a >100%-of-previous-stage number isn't mistaken for a bug. Verified live against
      real simulator data.
- [x] Attack-path visualization: per-actor condensed step sequence (`AttackPath.tsx`), derived
      client-side from the existing timeline data — collapses consecutive-duplicate steps,
      surfaces only high-signal event types (canary triggers, admin access, scanner/fuzzing
      detections) so it doesn't just repeat the raw timeline underneath it. Verified live: a
      scanner's probe sweep and a canary-hunter's discovery→reuse sequence both rendered
      correctly against real data.
- [x] Bot/agent classification model v1 — this was actually delivered in Phase 1
      (`packages/detection/src/botClassification.ts`, confidence-scored, never asserts certainty)
      and mislabeled as outstanding here; correcting the record rather than re-doing the work.
- [x] Alert delivery: webhook, Slack, and email (nodemailer) adapters
      (`packages/detection/src/alertDelivery.ts`), five rules — high request rate, sustained auth
      failures, large-scale enumeration, sensitive-path access, and canary triggered (brief §36) —
      with configurable thresholds and a per-(actor,rule) cooldown so an ongoing pattern doesn't
      spam delivery. **Verified end-to-end for real, not just unit-tested**: stood up a local
      webhook receiver, triggered a canary and a request-rate burst against the live stack, and
      confirmed both the correct JSON payload arrived at the webhook *and* the `ALERT_TRIGGERED`
      event persisted correctly — Slack/email adapters share the same delivery path and are
      exercised by the same code, but weren't individually re-verified since they need a Slack
      webhook / SMTP account this author doesn't have. New Alerts dashboard page.
- [x] "First contact" analytics: `/api/analytics/first-contact`, computed via a single SQL query
      (CTEs over events/detections/canary_events, not re-derived per-request) + dashboard page.
      Verified live — correctly showed 3 seconds from an actor's first request to their canary
      trigger against real simulator data.

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
- [x] Deployment made portable across a self-hosted VPS and a managed-Postgres PaaS (Render):
      role provisioning moved from `docker-entrypoint-initdb.d` (VPS-only) into idempotent
      Node code (`packages/db/src/ensureRoles.ts`) that runs identically against either; app
      config accepts either a full `DATABASE_URL` or `PGHOST`/`PGPORT`/`PGDATABASE` +
      role-password parts (`resolveDatabaseUrl.ts`), with TLS support for managed Postgres.
      Validated locally against a from-scratch vanilla Postgres container (no custom image), not
      just read from the code.
- [x] VPS/AWS EC2 runbook written and scripted: `infrastructure/vps/bootstrap.sh` (Docker, ufw,
      fail2ban, unattended-upgrades) + `infrastructure/vps/setup-tls.sh` (Let's Encrypt via
      certbot standalone, renewal cron) + `docs/DEPLOYMENT.md` §3 walks the whole sequence.
      **Not yet executed against a real VPS** — scripted and internally consistent, not
      field-tested on an actual DigitalOcean/Hetzner/EC2 box.
- [x] AWS specifically also gets full provisioning automation, not just a manual runbook:
      `infrastructure/aws/provision.sh` (idempotent — key pair, security group scoped to the
      caller's IP for SSH, latest Ubuntu AMI, EC2 instance, Elastic IP) and `deploy.sh` (syncs
      the repo, bootstraps, generates secrets once, migrates, seeds, brings up the stack) — see
      `docs/AWS_SETUP.md`. Same "not yet executed against a live account" caveat as above; the
      AWS CLI syntax was reasoned through carefully, not run against real AWS.
- [x] Render path documented as a real alternative: `render.yaml` deploys only the public
      honeypot + managed Postgres; admin-api/admin-web deliberately run locally against Render's
      Postgres rather than guessing at unverified Render private-networking behavior — see
      `docs/DEPLOY_RENDER.md` "how this differs" section. **Not yet executed against a real
      Render account** — the blueprint's exact field names/plan slugs should be checked against
      Render's current dashboard before first use.
- [x] Admin dashboard access made an explicit choice, not a default: VPS §4 Option A (SSH
      tunnel, no extra infrastructure) or Option B (public, same-origin proxy, own login wall —
      `infrastructure/vps/setup-public-admin.sh`); Render deploys it publicly by default since
      the tunnel approach has no Render equivalent (`docs/DEPLOY_RENDER.md`). The public options
      needed real changes, not just config: configurable cookie `SameSite` policy
      (`ADMIN_SESSION_SAMESITE`), tightened IP+username login rate limiting, and a runtime
      `config.js` injection mechanism for admin-web so admin-api's URL doesn't need to be known
      at Docker build time. Same-origin proxy routing validated locally end-to-end (real
      admin-api container behind the same-origin Nginx proxy); the Render `fromService`
      cross-service URL wiring and both TLS setup scripts remain unverified against live
      accounts — see docs/DEPLOY_RENDER.md §2 and docs/DEPLOYMENT.md §3.3/§4 for the documented
      manual fallbacks if they don't resolve as expected.
      A real VPN/Tailscale swap for Option A remains optional future hardening, not done.
- [ ] Monitoring of the monitoring: ingestion-health metrics + dead-man's-switch alert if events
      stop flowing.
- [ ] Retention cron jobs running on schedule, verified against `RAW_IP_RETENTION_DAYS` etc.
- [ ] Public deployment security checklist (docs/DEPLOYMENT.md §6) fully checked off against a
      real running deployment, not just readable as a checklist.

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
