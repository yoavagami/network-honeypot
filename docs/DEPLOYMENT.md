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

**If your VPS is AWS EC2 and you're starting from nothing** (no AWS account, no CLI), skip ahead
to [`docs/AWS_SETUP.md`](AWS_SETUP.md) instead — it covers the same ground but automates
everything past the account/IAM setup via `infrastructure/aws/provision.sh` + `deploy.sh`, rather
than the manual `ssh` + copy-paste sequence below (§3.1–3.2), which is written for any VPS
provider generically.

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
- **Backup**: `scripts/backup.sh [output-dir]` — runs `pg_dump --format=custom` inside the running
  `postgres` container (no host Postgres client tools required), optionally GPG-encrypting the
  result if `BACKUP_GPG_RECIPIENT` is set. Move the output off-host for real production use.
- **Restore**: `scripts/restore.sh <dump-file>`, after `docker compose up -d postgres` (fresh
  volume) and `pnpm migrate` (recreates schema + `honeypot_role`/`admin_api_role`). The script
  runs `pg_restore --data-only --disable-triggers --no-owner`, truncating `_migrations` first —
  see the comments in `scripts/restore.sh` for why `--clean` doesn't work against partitioned
  tables. Verify row counts (`actors`, `admin_users`, `canary_objects`, `requests`, `events`,
  `detections`, ...) against a known baseline before pointing traffic at it again.
  - **Drilled for real (2026-08-19)**: backed up the live dev stack (144 requests, 378 events, 10
    actors, 10 detections, 1 admin user, 3 canary objects, 2 canary events, 14 synthetic objects),
    restored into an isolated fresh Postgres container (not the live DB) simulating a
    disaster-recovery box. First attempt used `--clean --if-exists`, which failed with 8 errors —
    `pg_restore` generates `ALTER TABLE ONLY <partition> DROP CONSTRAINT ... _pkey` per monthly
    partition, but Postgres refuses to drop a partition's *inherited* primary key that way; it has
    to go through the parent partitioned table. The restore actually completed anyway (Postgres
    ran the DROPs it could and pg_restore reported "errors ignored on restore: 8"), and row counts
    matched the baseline exactly — but treating 8 swallowed errors as "fine" isn't something to
    ship. Root cause: `--clean` is pointless here in the first place, since the documented
    sequence already runs `pnpm migrate` to build a correct empty schema before restoring — so the
    fix was to drop `--clean` and use `--data-only` instead. That surfaced one more real conflict
    (`_migrations` primary-key collision, since `pnpm migrate` already recorded its own rows there
    with the same keys the dump has) — fixed by truncating `_migrations` immediately before the
    data-only restore. Re-ran end-to-end against a clean drill instance: exit code 0, zero errors,
    all 9 tables (including `_migrations`) matched baseline exactly. Drill container/volume torn
    down afterward; live dev stack was never touched by any of this.
- **Retention**: `pnpm retention` (`packages/db/src/retention.ts`) — NULLs `requests.ip_raw` past
  `RAW_IP_RETENTION_DAYS`, creates the next few months' partitions, and drops `requests`/`events`
  partitions entirely past `EVENT_RETENTION_DAYS`. Runs as the Postgres superuser (same connection
  as `pnpm migrate`), never as `honeypot_role` — see the file header for why. `deploy.sh` installs
  it as a daily 3am cron job via `infrastructure/vps/retention-cron.sh`; a non-AWS VPS can install
  the same crontab line by hand.
  - **Drilled for real (2026-08-19)**: verified all three behaviors against an isolated Postgres
    instance with synthetic old/new rows, not just read the code. Found and fixed a real bug along
    the way: the first version interpolated a SQL `date`-typed value into a raw DDL string, and
    postgres.js parses `date` columns into JS `Date` objects — `${start_date}`'s `toString()`
    produced a locale-formatted string like `"Tue Oct 01 2026 GMT+0200 (...)"`, which Postgres
    rejected as an invalid timestamp literal. Fixed by selecting the dates as pre-formatted text
    (`to_char(...)`) instead of the `date` type. After the fix: an old row's `ip_raw` was redacted
    while a same-day row was left alone; a deleted future partition was correctly recreated; and,
    with `EVENT_RETENTION_DAYS` set low for the test, exactly the one expired partition pair was
    dropped and nothing else. Also found the same `pnpm install --frozen-lockfile` interactive-
    purge-prompt issue as the retention-cron wrapper script hit (see below) — both now pass
    `CI=true`.
- **Ingestion health / dead-man's-switch**: the honeypot app runs an in-process health monitor
  (`apps/honeypot/src/ingestion/healthMonitor.ts`) that fires a critical alert (through the same
  webhook/Slack/email adapters as the Phase 2 alert rules, plus an always-on error-level log line)
  if the ingestion queue hasn't successfully flushed to Postgres in `INGESTION_STALL_THRESHOLD_MS`
  (default 5 minutes) while the app has kept receiving traffic. `/internal/metrics`
  (nginx-blocked from the public network) exposes the underlying counters for external polling.
  - **Drilled for real (2026-08-19)**: stopped the live `postgres` container while sending
    continuous traffic to the honeypot, and found three real bugs this way, not by reading code:
    1. **The whole honeypot process crashed** and entered a restart loop. `correlationWorker.ts`,
       `canaries.ts`, and the new health monitor all scheduled their periodic work as
       `setInterval(() => void asyncFn(), ...)` — a rejected promise inside becomes an unhandled
       rejection, which Node terminates the process on by default. Fixed by having each interval
       callback `.catch()` and log instead of leaving the rejection unhandled.
    2. **A poisoned actor silently broke correlation for every other actor.** A request whose
       actor resolution failed mid-outage still fell through to `recentBuffer.record("", ...)`
       with the module's unset `""` placeholder actor ID, and every later correlation tick threw
       `invalid input syntax for type uuid: ""` trying to query it — aborting that tick for every
       *other* actor too, for up to `recentBuffer`'s 15-minute window, since there was no
       per-actor isolation. Fixed two ways: `capture.ts` now drops (rather than records) telemetry
       for a request whose actor never resolved, and `correlationWorker.ts` now wraps each actor's
       processing in its own try/catch so one bad actor can't take down the rest of the tick.
    3. **The dead-man's-switch didn't fire during a *total* outage** — the exact case it exists
       for. It was originally keyed on `metrics.eventsReceivedTotal`, which only increments once a
       row reaches `queue.enqueue()`; once bug 2's fix started dropping unresolvable-actor requests
       *before* that point, a total outage meant nothing ever reached the queue, so that counter
       never moved and the switch stayed silent. Fixed by keying it on `metrics.requestsTotal`
       instead, which increments unconditionally at the top of request finalization, before the
       actor-resolution check.
    Re-ran the full drill after all three fixes: process stayed up throughout, the alert fired
    within one check interval and kept firing on cooldown until Postgres came back, and traffic
    resumed cleanly (200s, no lingering errors) once it did. `pnpm test` (61 tests) and a full
    `pnpm typecheck` both still pass.
- **Investigate an actor**: admin dashboard → Actors → search/filter → profile → timeline; or
  `GET /api/actors/:id/timeline` directly for scripting.
