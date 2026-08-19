# Network Honeypot — Threat Observation Platform

A realistic-looking public web application whose real purpose is to attract, deceive, and
observe automated agents, bots, scanners, and attackers — while keeping the observation
infrastructure fully isolated from anything a compromise of the public surface could reach.

**Attract → Deceive → Observe → Record → Correlate → Learn**

## Start here

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — the phased end plan; what's built, what's stubbed, what's next.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, network topology, technology decisions.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — who we expect, what we defend against, adversarial Q&A.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — schema, partitioning, retention, redaction.
- [`docs/DETECTION.md`](docs/DETECTION.md) — event taxonomy, detection engine, risk scoring.
- [`docs/API.md`](docs/API.md) — admin API surface.
- [`docs/SECURITY.md`](docs/SECURITY.md) — headers, isolation, admin auth, adversarial review checklist.
- [`docs/ATTACK_SURFACE.md`](docs/ATTACK_SURFACE.md) — expanded surface/telemetry matrix.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — what's collected, why, retention, legal notes.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — VPS/AWS EC2 deployment (recommended path), checklist, operations.
- [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md) — alternative Render deployment, and how it differs from the VPS path.

## Repository structure

```
apps/
  honeypot/     # the public deceptive site + fake API (what attackers touch)
  admin-api/    # authenticated telemetry API, separate service + DB role
  admin-web/    # SOC-style React dashboard, talks only to admin-api
packages/
  types/        # shared zod schemas & event taxonomy
  detection/    # detection rules, risk scoring, actor correlation (pure, unit-tested)
  db/           # Drizzle schema, migrations, scoped-role client factories
  logging/      # structured logger with redaction
infrastructure/
  nginx/        # reverse proxy config — the primary HTTP observation point
  docker/       # Dockerfiles
  vps/          # VPS/AWS EC2 bootstrap + TLS setup scripts
scripts/
  seed.ts               # synthetic users, documents/invoices, canary objects
  simulate-traffic.ts    # recon/enumeration/auth-probe/fuzzing/canary attacker simulator
docs/           # design docs (read these first)
render.yaml     # Render Blueprint — alternative deployment path, see docs/DEPLOY_RENDER.md
```

## Status

Phase 1 (foundation + deception + detection + dashboard) — see
[`docs/ROADMAP.md`](docs/ROADMAP.md) for exactly what's implemented vs. designed-and-stubbed.

## Quickstart

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §2 for local dev, §3 for the public-deployment
security checklist (do not skip it before exposing this to the internet).

## Safety

This system is purely defensive. It never issues requests derived from visitor input, never
attacks or exploits visitors, and never stores real credentials. See
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) §6 for the explicit out-of-scope list.
