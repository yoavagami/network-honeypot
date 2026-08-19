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
pnpm migrate                    # also provisions honeypot_role/admin_api_role — see
                                 # packages/db/src/ensureRoles.ts, portable to managed Postgres too
pnpm seed
docker compose up -d --build
```
Public honeypot: http://localhost:8080
Admin dashboard: http://localhost:8081 (kept off the public compose network's published port
range that maps to Nginx; in Phase 1 local dev this is a convenience port, in Phase 4 production
this port is not published to the internet at all — see §4).

## 3. Deploy to a VPS (DigitalOcean, Hetzner, Linode, AWS EC2, ...)

This is the deployment path that matches the threat model exactly — a dedicated public IP, your
own Nginx as the real ingress, full container isolation as designed. `infrastructure/vps/`
has the scripts; this is the concrete sequence.

### 3.1 Provision the host

Any of these work identically from here on — the only difference is how you click through their
console to get a running box:

- **DigitalOcean / Hetzner / Linode**: create a droplet/server, Ubuntu 22.04+ or Debian 12+,
  smallest size that has ≥1GB RAM (Hetzner CX22, DO Basic 1GB, Linode Nanode — all ~$4-6/mo).
  Add your SSH key at creation time; skip password auth entirely.
- **AWS EC2**: launch an instance with the Ubuntu Server 22.04/24.04 LTS AMI, a `t3.micro` or
  `t4g.micro` (cheaper, ARM — our Docker images build fine on arm64) is enough for Phase 1.
  Create/select a key pair for SSH. **Security group**: inbound rules for TCP 22 (SSH, ideally
  restricted to your IP), TCP 80, TCP 443 — nothing else. Allocate and associate an Elastic IP so
  the address doesn't change on stop/start.

Either way you end up with: a public IPv4 address, SSH access via a key, and root/sudo.

### 3.2 Bootstrap and deploy

```bash
ssh ubuntu@<host-ip>                       # or root@ for some providers — use whatever the
                                            # provider's default user is
git clone <your-fork-of-this-repo> network-honeypot
cd network-honeypot
bash infrastructure/vps/bootstrap.sh       # installs Docker, ufw, fail2ban, unattended-upgrades
newgrp docker                              # or log out/in — picks up the docker group membership

cp .env.example .env
nano .env                                  # fill in every secret with real random values —
                                            # `openssl rand -base64 32` per secret is fine

docker compose up -d postgres
# Node isn't required on the host for this — run migrate/seed from a throwaway container using
# the repo's own tooling image so you don't need to install pnpm on the VPS:
docker run --rm --network container:$(docker compose ps -q postgres) \
  --env-file .env -e DATABASE_URL="postgres://$(grep ^POSTGRES_SUPERUSER= .env | cut -d= -f2):$(grep ^POSTGRES_SUPERUSER_PASSWORD= .env | cut -d= -f2)@localhost:5432/$(grep ^POSTGRES_DB= .env | cut -d= -f2)" \
  -v "$PWD":/app -w /app node:22-bookworm-slim bash -c "corepack enable && pnpm install --frozen-lockfile && pnpm migrate && pnpm seed"

docker compose up -d --build
curl -I http://localhost                  # sanity check before opening the firewall further
```

### 3.3 Put it on a domain with TLS (recommended, optional)

If you have a domain, point an A record at the host's IP, wait for it to resolve
(`dig +short yourdomain.example`), then:

```bash
infrastructure/vps/setup-tls.sh yourdomain.example you@example.com
```

This issues a Let's Encrypt certificate, switches Nginx to the TLS config
(`infrastructure/nginx/honeypot-tls.conf`), and prints the crontab line for renewal. Without a
domain, the honeypot still works fine over plain HTTP on the bare IP — a domain mainly buys you
HSTS/valid-cert realism, which matters for the deception but isn't required to start observing
scanning traffic.

### 3.4 Verify, then walk away

```bash
curl -I http://<host-ip>/            # or https://yourdomain.example/
```

That's the moment the honeypot becomes reachable. From here, don't browse to it yourself again —
per your own instrumentation, that traffic would show up as an actor in the dashboard just like
anyone else's. Reach the admin dashboard only via an SSH tunnel (see §4 below), never by
publishing its port.

## 4. Reaching the admin dashboard on a VPS — two options

**Option A — SSH tunnel (default, recommended).** The admin surface (`admin-api` on 8090,
`admin-web` on 8081) is bound to `127.0.0.1` on the VPS by design — see `docker-compose.yml`. To
reach it from your laptop, tunnel over SSH instead of opening a firewall port for it:

```bash
ssh -N -L 8081:localhost:8081 -L 8090:localhost:8090 ubuntu@<host-ip>
```

Then browse to `http://localhost:8081` on your own machine exactly as in local dev — the traffic
never touches the public internet. Close the tunnel (Ctrl-C) when you're done. This is the VPN
requirement from THREAT_MODEL.md/SECURITY.md satisfied with zero extra infrastructure.

**Option B — public, with a login wall.** If SSH access isn't convenient for how you want to use
this (e.g. checking the dashboard casually from a phone, or you've decided the tradeoff below is
fine for your use), you can expose the dashboard directly instead:

```bash
infrastructure/vps/setup-public-admin.sh yourdomain.example
```

This makes the dashboard reachable at `https://yourdomain.example:8443` with no tunnel — protected
by the app's own login (Argon2id password, session cookie, CSRF, rate-limited by both IP and
username) rather than network isolation. Requires `setup-tls.sh` (§3.3) to have already run for
the same domain — it reuses that certificate. admin-web's own Nginx terminates TLS and proxies
`/api/*` straight through to `admin-api` internally, so the dashboard and its API calls stay
same-origin — no CORS or cookie-policy relaxation needed, unlike the Render public path.

**The tradeoff, same as documented in `docs/DEPLOY_RENDER.md`**: this is a deliberate choice, not
a default. The login is real and the blast radius of a compromise is already bounded by database
role isolation (`admin_api_role` can't write telemetry, can't reach Postgres directly, can't reach
the honeypot app — verified in `docs/SECURITY.md` §5) — but it does mean the admin login itself
becomes internet-reachable and could be probed. Pick Option A if that doesn't sit right for your
use. You can switch back at any time:

```bash
sudo ufw delete allow 8443/tcp
docker compose -f docker-compose.yml up -d admin-web
```

## 5. Deploying to Render instead

See `docs/DEPLOY_RENDER.md` and `render.yaml` for the equivalent path on Render. That path
deploys the dashboard publicly too (Render doesn't offer an equivalent to Option A above — see
that doc for why), but the architecture differs from Option B in a real way: Render's own edge
terminates TLS in front of independently-hosted services, so admin-web and admin-api end up on
different hostnames and *do* need the CORS/cookie-policy relaxation this VPS path avoids. Read
that doc's comparison table before assuming behavior is identical.

## 6. Public deployment security checklist

- [ ] **DNS**: A/AAAA records point only at the intended host; no wildcard pointing at the admin
      surface.
- [ ] **TLS**: `infrastructure/vps/setup-tls.sh` run against a domain pointed at the host;
      renewal cron entry (printed by the script) actually added to the crontab, not just noted.
- [ ] **Firewall**: default-deny inbound; only 22/80/443 open publicly (`infrastructure/vps/bootstrap.sh`
      configures this via ufw). SSH restricted to an allowlist or moved behind a bastion/VPN if
      more than convenience-level protection is needed.
- [ ] **SSH**: key-only auth, root login disabled, fail2ban or equivalent on the SSH port.
- [ ] **Docker**: daemon not exposed on a TCP socket; no `--privileged` containers; images pinned
      by digest, not floating `latest`.
- [ ] **Nginx**: config from `infrastructure/nginx` deployed as-is (rate/connection limits,
      security headers, buffer/timeout hardening); default server block returns a closed
      connection for unmatched Host headers (no accidental info disclosure via SNI/Host
      mismatch).
- [ ] **Database**: `postgres`'s port stays bound to `127.0.0.1` (as shipped) or unpublished
      entirely — never `0.0.0.0`. Loopback binding is sufficient (unreachable from outside the
      host by definition) and is what lets `pnpm migrate`/`pnpm seed` run without extra tooling.
- [ ] **Admin access**: a deliberate choice has been made between §4's Option A (SSH tunnel —
      `admin-api`/`admin-web` stay bound to `127.0.0.1`, never reachable from the open internet)
      and Option B (public with a login wall) — not defaulted into either. If Option B, confirm
      the login rate limiter is active and the admin password is a real generated one, not a
      placeholder.
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

## 7. Performance — tested capacity

Filled in after the Phase 1 load-test pass (scripts/simulate-traffic.ts in burst mode) against the
local Compose stack on development hardware; see the results appended after that test runs. The
design targets are in ARCHITECTURE.md §14 — this section records what was *actually measured*,
which is the number that matters, not the aspiration.

## 8. Operations quick reference

- **Rotate a secret**: update `.env` on the host, `docker compose up -d <service>` to recreate
  just that container; DB-role passwords are rotated via a migration-adjacent SQL script plus the
  corresponding `.env` update, applied together.
- **Backup**: `docker compose exec postgres pg_dump ... | gpg --encrypt ... > backup.sql.gpg`
  (exact invocation in `scripts/backup.sh`, Phase 3).
- **Restore**: provision a fresh Postgres volume, replay migrations, `pg_restore`/`psql < dump`,
  verify `admin_users` and `canary_objects` came back before pointing traffic at it again.
- **Investigate an actor**: admin dashboard → Actors → search/filter → profile → timeline; or
  `GET /api/actors/:id/timeline` directly for scripting.
