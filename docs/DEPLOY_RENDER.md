# Deploying to Render

An alternative to the VPS path in `docs/DEPLOYMENT.md`. This deploys the **admin dashboard
publicly**, protected by the app's own login rather than network isolation — a deliberate
tradeoff for ease of access, made explicitly (not a default anyone should assume). Read "the
tradeoff" section before launching.

## The tradeoff, stated plainly

`docs/THREAT_MODEL.md`/`docs/SECURITY.md` specify the admin surface should never be reachable
from the public internet. This deployment path reaches it publicly anyway, because:

- The dashboard's own auth is real, not decorative: Argon2id password hashing, server-side
  session cookies, CSRF protection, and — as of this doc — rate-limiting keyed by both IP and
  username (5 attempts/min per IP, 5 attempts/15min per username; see `apps/admin-api/src/middleware.ts`).
- The blast radius of a break-in is already bounded by database role isolation, independent of
  network exposure: `admin_api_role` cannot write to `requests`/`events` (verified live in
  `docs/SECURITY.md` §5), can't reach the honeypot app, can't reach Postgres directly. Worst case
  is someone reads your telemetry, not that they compromise anything else.
- This project's data isn't sensitive to begin with — it's synthetic users, fake invoices, and
  hashed IPs of people scanning a honeypot.

If those tradeoffs don't sit right for your use — e.g. you're worried about the admin login
itself being probed the same way the honeypot attracts probing — see "keeping it private
instead" at the bottom, which runs admin-api/admin-web locally against the same Render database
instead of deploying them there at all.

## How this differs from the VPS path otherwise

| | VPS (docs/DEPLOYMENT.md) | Render |
|---|---|---|
| Public ingress | Our own Nginx — full control over rate limits, security headers, TLS config, real `$ssl_protocol`/`$ssl_cipher` capture | Render's own edge terminates TLS and proxies directly; we lose that Nginx-layer telemetry (app-level detection is unaffected) |
| Admin dashboard | Bound to loopback; reach it via SSH tunnel, or the AWS "public option" same-origin proxy (see `docs/DEPLOYMENT.md` §5) | Deployed as its own public Render service, reached directly at its URL — no tunnel |
| Cookie policy | `SameSite=Strict` works (tunnel and same-origin-proxy cases are same-site) | `SameSite=None` required — admin-web and admin-api are different Render hostnames, so `Strict` would silently drop the session cookie; CORS (locked to one origin) is the actual access boundary |
| Postgres | Self-hosted, never publicly reachable | Render managed Postgres — has a real external connection string by design; TLS-enforced |
| Cost shape | ~$5–12/mo, one box | Three services + a database, each billed separately |

## 1. Launch the blueprint

1. Push this repo to GitHub/GitLab.
2. Render dashboard → **Blueprints → New Blueprint Instance** → point at the repo. It reads
   `render.yaml` and provisions `honeypot-db`, `honeypot`, `admin-api`, and `admin-web`.
3. `honeypot-db` uses the `free` Postgres plan — $0/mo, but **Render deletes the database (and
   everything in it) 30 days after creation**. That's a deliberate "testing pass" choice, not an
   oversight — swap it to `basic-256mb` (~$7/mo, no expiry) in `render.yaml` before relaunching
   the blueprint if this deployment is meant to stick around. The three `web` services still use
   `plan: starter`, which (unlike the old Postgres plan names) Render hasn't renamed.
4. Wait for all four resources to finish provisioning.

## 2. Verify the cross-service env vars resolved (the part this author couldn't test live)

`render.yaml` uses `fromService: { ..., property: hostport }` so `admin-web` learns admin-api's
URL, and `admin-api` learns admin-web's URL (for CORS) and honeypot's URL (for the ingestion
health check on the dashboard's Overview page). This is the author's best understanding of
Render's Blueprint spec — **verify it actually worked**:

- Open the deployed `admin-web` URL. If the dashboard loads but every request fails, `admin-api`'s
  URL didn't resolve correctly.
- Check by hand: `admin-api`'s dashboard → Environment tab → confirm `ADMIN_WEB_ORIGIN` shows
  admin-web's real `https://admin-web-xxxx.onrender.com` URL, not empty or malformed. Same for
  `admin-web`'s `ADMIN_API_URL`.
- **If either is wrong**: set it manually in that service's Environment tab to the correct URL
  (copy it from the other service's own page) and trigger a restart. Because
  `ADMIN_API_URL` is read at container *start*, not baked into the build (see
  `infrastructure/docker/admin-web-entrypoint.sh`), a restart is enough — no rebuild needed.

## 3. Run migrations + seed

Nothing on Render runs this for you — do it from your own machine, using the values Render
generated:

```bash
# Render dashboard: honeypot-db -> Connect -> "External Connection String"
export DATABASE_URL="<paste the external connection string>"
export HONEYPOT_DB_PASSWORD="<from honeypot service's Environment tab>"
export ADMIN_API_DB_PASSWORD="<from admin-api service's Environment tab>"
export SEED_ADMIN_USERNAME=admin
export SEED_ADMIN_PASSWORD="$(openssl rand -base64 18)"   # save this — it's your dashboard login

pnpm install
pnpm migrate
pnpm seed
echo "Admin login: $SEED_ADMIN_USERNAME / $SEED_ADMIN_PASSWORD"
```

## 4. Use it

- Honeypot: the `honeypot` service's Render URL (or a custom domain attached in its Settings).
  Don't browse to it yourself if you want a clean "first external contact" signal.
- Dashboard: the `admin-web` service's Render URL. Log in with the credentials from step 3.

## Keeping it private instead

If you'd rather not put the admin surface on the public internet even with a login wall, delete
the `admin-api` and `admin-web` blocks from `render.yaml` (keep `honeypot-db` and `honeypot`),
and run the dashboard locally instead, pointed at Render's database over its external connection
string:

```bash
export DATABASE_SSL=true
export PGHOST="<honeypot-db host>" PGPORT=5432 PGDATABASE="<honeypot-db database>"
export ADMIN_API_DB_PASSWORD="<the one you generated>"
export IP_HASH_SECRET="<copy from the honeypot service's Environment tab — must match exactly>"
export SESSION_SECRET="$(openssl rand -base64 32)"
export ADMIN_WEB_ORIGIN="http://localhost:5173"
export HONEYPOT_INTERNAL_URL="https://<your-honeypot-service>.onrender.com"
unset DATABASE_URL   # so resolveDatabaseUrl() builds the admin_api_role connection from the
                      # PG*/ADMIN_API_DB_PASSWORD parts above, not the owner URL
pnpm --filter @honeypot/app-admin-api run start
```
```bash
cd apps/admin-web && VITE_ADMIN_API_URL=http://localhost:8090 pnpm dev
```
Dashboard at `http://localhost:5173`, nothing Render-hosted involved beyond the database.
