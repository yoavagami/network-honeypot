# Deployment

## 1. Recommendation: hardened single VPS + Docker Compose (not Kubernetes)

For the traffic profile and threat model here (a single public-facing HTTP(S) surface, no
requirement for multi-region or zero-downtime rolling fleets), a single hardened VPS running
Docker Compose is the right complexity level:

- One host to patch, firewall, and monitor.
- Compose's network segmentation (public/internal/admin) already delivers the isolation this
  project needs (§3 of ARCHITECTURE.md) without an orchestrator's additional attack surface
  (API server, etcd, kubelet, RBAC surface) — none of which reduces *this* project's risk, since
  the risk we're managing is "the exposed app gets popped," not "we need to reschedule pods
  across failed nodes."
- Cloud-managed options (Render/Fly.io/a managed k8s) are valid *later* if horizontal scaling of
  the honeypot app becomes necessary (Phase 5) — revisit then, driven by actual load data, not
  preemptively.

Any VPS provider works; the requirements are: a recent Linux distro with unattended security
updates available, a firewall (ufw/nftables) in front, and enough disk for the retention window
chosen in DATA_MODEL.md.

## 2. Local development / Phase 1 POC run

```
cp .env.example .env            # fill in secrets; nothing ships with defaults for anything
                                 # security-sensitive
docker compose up -d postgres
pnpm --filter @honeypot/db migrate
pnpm --filter @honeypot/db seed
docker compose up -d --build
```
Public honeypot: http://localhost:8080
Admin dashboard: http://localhost:8081 (kept off the public compose network's published port
range that maps to Nginx; in Phase 1 local dev this is a convenience port, in Phase 4 production
this port is not published to the internet at all — see §4).

## 3. Public deployment security checklist

- [ ] **DNS**: A/AAAA records point only at the intended host; no wildcard pointing at the admin
      surface.
- [ ] **TLS**: Let's Encrypt via a small ACME client on the host (or Nginx's own), auto-renewal
      verified, HSTS enabled once confirmed working.
- [ ] **Firewall**: default-deny inbound; only 80/443 open publicly. SSH restricted to an
      allowlist or moved behind a bastion/VPN.
- [ ] **SSH**: key-only auth, root login disabled, fail2ban or equivalent on the SSH port.
- [ ] **Docker**: daemon not exposed on a TCP socket; no `--privileged` containers; images pinned
      by digest, not floating `latest`.
- [ ] **Nginx**: config from `infrastructure/nginx` deployed as-is (rate/connection limits,
      security headers, buffer/timeout hardening); default server block returns a closed
      connection for unmatched Host headers (no accidental info disclosure via SNI/Host
      mismatch).
- [ ] **Database**: `postgres` service has no published host port at all in the production
      compose override; only reachable on the `internal` Docker network.
- [ ] **Admin access**: dashboard is placed behind a VPN/Tailscale/IP-allowlist at the network
      layer *in addition to* its own auth — never reachable from the open internet directly.
- [ ] **Backups**: nightly `pg_dump` to encrypted, off-host storage; a restore drill has actually
      been performed (not just scripted) before go-live.
- [ ] **Monitoring**: `/internal/metrics` scraped or at minimum checked on a schedule; an alert
      exists for `events_dropped_total` trending up or `last_successful_flush_at` going stale.
- [ ] **Log retention**: Nginx access/error log rotation configured (logrotate), bounded disk
      usage.
- [ ] **Resource limits**: Compose service `mem_limit`/`cpus` set on every container so one
      service misbehaving can't starve the host.
- [ ] **Secrets**: unique per service, not committed, provisioned via the host's `.env` (or a
      secrets manager if the provider offers one) — never baked into images.
- [ ] **Updates**: unattended OS security updates enabled; a documented (even if manual) cadence
      for pulling updated base images and re-deploying.
- [ ] **Dependency scanning**: `pnpm audit` / `npm audit` (or a Dependabot-equivalent) run as part
      of CI before any image build reaches production.

## 4. Performance — tested capacity

Filled in after the Phase 1 load-test pass (scripts/simulate-traffic.ts in burst mode) against the
local Compose stack on development hardware; see the results appended after that test runs. The
design targets are in ARCHITECTURE.md §14 — this section records what was *actually measured*,
which is the number that matters, not the aspiration.

## 5. Operations quick reference

- **Rotate a secret**: update `.env` on the host, `docker compose up -d <service>` to recreate
  just that container; DB-role passwords are rotated via a migration-adjacent SQL script plus the
  corresponding `.env` update, applied together.
- **Backup**: `docker compose exec postgres pg_dump ... | gpg --encrypt ... > backup.sql.gpg`
  (exact invocation in `scripts/backup.sh`, Phase 3).
- **Restore**: provision a fresh Postgres volume, replay migrations, `pg_restore`/`psql < dump`,
  verify `admin_users` and `canary_objects` came back before pointing traffic at it again.
- **Investigate an actor**: admin dashboard → Actors → search/filter → profile → timeline; or
  `GET /api/actors/:id/timeline` directly for scripting.
