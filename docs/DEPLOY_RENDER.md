# Deploying to Render

An alternative to the VPS path in `docs/DEPLOYMENT.md`. Read this whole doc before launching —
Render's architecture is different enough from the VPS/Docker-Compose design that a few things
work differently, not just "the same thing, hosted differently."

## How this differs from the VPS path (read this first)

| | VPS (docs/DEPLOYMENT.md) | Render |
|---|---|---|
| Public ingress | Our own Nginx (`infrastructure/nginx/`) — full control over rate limits, security headers, TLS config, and it's the thing that gives Nginx access/error logs real meaning | Render's own edge/load balancer terminates TLS and proxies to the honeypot container directly. We lose custom Nginx-layer rate limiting and TLS handshake visibility (`$ssl_protocol`/`$ssl_cipher` in requests) — the app's own security headers and detection logic are unaffected, this only affects the Nginx-layer telemetry described in ARCHITECTURE.md §10 |
| Admin dashboard access | SSH tunnel to loopback-bound ports (`docs/DEPLOYMENT.md` §4) — admin-api/admin-web actually run *on* the VPS | admin-api/admin-web are **not deployed to Render at all** — you run them locally, pointed at Render's Postgres over its external connection string. See below for why. |
| Postgres | Self-hosted in the same Compose stack, never publicly reachable | Render managed Postgres — has a real external connection string by design (that's how you reach it from your laptop); TLS-enforced |
| Cost shape | One VPS running everything, ~$5–12/mo | `honeypot-db` (Postgres) + `honeypot` (web service), each billed separately |

**Why admin-api/admin-web aren't deployed to Render**: the dashboard is a browser SPA — your
browser makes `fetch()` calls directly to admin-api's URL. On a VPS, an SSH tunnel makes
`localhost:8090` on your laptop transparently reach the VPS's loopback-bound admin-api, so the
browser-side code never needs to know anything special. Render's private services (`pserv`) are
reachable from other Render services in the same project, but this author could not verify that
Render offers an equivalent generalized "tunnel any private service to my laptop" mechanism (the
one Render feature confirmed to work this way is Postgres's own connect flow) — rather than build
a deployment path on an unverified assumption, admin-api/admin-web simply run wherever you already
run them today (your laptop, `docker compose`), talking to the same Postgres Render hosts. The
admin surface still never touches the public internet — it just does so by not being on Render,
not by a Render access-control feature.

If Render does have a generalized private-service tunnel by the time you read this, deploying
admin-api/admin-web there too is a reasonable follow-up — just verify it actually prevents public
reachability before relying on it.

## 1. Launch the blueprint

1. Push this repo to GitHub/GitLab (Render deploys from a git remote).
2. In the Render dashboard: **Blueprints → New Blueprint Instance**, point it at the repo. Render
   reads `render.yaml` and provisions `honeypot-db` (Postgres) and `honeypot` (the public web
   service) — nothing else.
3. If `render blueprint launch` rejects the `plan: starter` value, open `render.yaml` and pick a
   currently-valid plan name from your dashboard — Render renames tiers occasionally and this
   wasn't verified against a live account.
4. Wait for both resources to finish provisioning. Note the `honeypot` service's public URL
   (`https://honeypot-xxxx.onrender.com`, or a custom domain if you attach one in Render's
   dashboard under that service's Settings).

## 2. Run migrations + seed

`render.yaml` generates `HONEYPOT_DB_PASSWORD` and `IP_HASH_SECRET` automatically, but nothing on
Render runs the migration/seed step for you — do it from your own machine, which is also how
you'll get `ADMIN_API_DB_PASSWORD` (never generated on Render at all, since admin-api never runs
there):

```bash
# From the Render dashboard: honeypot-db -> Connect -> "External Connection String". It looks like
# postgresql://<user>:<password>@<host>.render.com:5432/<database>?sslmode=require
export DATABASE_URL="<paste the external connection string here>"
export HONEYPOT_DB_PASSWORD="<copy from the honeypot service's Environment tab on Render>"
export ADMIN_API_DB_PASSWORD="$(openssl rand -base64 24)"   # you're choosing this one yourself
export SEED_ADMIN_USERNAME=admin
export SEED_ADMIN_PASSWORD="$(openssl rand -base64 18)"     # save this, it's your dashboard login

pnpm install
pnpm migrate     # provisions honeypot_role + admin_api_role against Render's Postgres, then runs
                  # migrations — see packages/db/src/ensureRoles.ts
pnpm seed
echo "Admin login: $SEED_ADMIN_USERNAME / $SEED_ADMIN_PASSWORD"
```

## 3. Run the admin dashboard locally, pointed at Render's database

```bash
export DATABASE_SSL=true
export PGHOST="<honeypot-db host, from Render's Connect tab>"
export PGPORT=5432
export PGDATABASE="<honeypot-db database name>"
export ADMIN_API_DB_PASSWORD="<the one you generated in step 2>"
export IP_HASH_SECRET="<copy from the honeypot service's Environment tab on Render — must match
                        exactly, or actor/IP correlation between what admin-api shows you and
                        what the honeypot recorded will silently disagree>"
export SESSION_SECRET="$(openssl rand -base64 32)"
export ADMIN_WEB_ORIGIN="http://localhost:5173"
export HONEYPOT_INTERNAL_URL="https://<your-honeypot-service>.onrender.com"
unset DATABASE_URL   # so resolveDatabaseUrl() builds the admin_api_role connection from the
                      # PG*/ADMIN_API_DB_PASSWORD parts above, not the owner URL from step 2
pnpm --filter @honeypot/app-admin-api run start
```

In another terminal:

```bash
cd apps/admin-web
VITE_ADMIN_API_URL=http://localhost:8090 pnpm dev
```

Dashboard: `http://localhost:5173`, login with the `SEED_ADMIN_USERNAME`/`SEED_ADMIN_PASSWORD`
from step 2. This is exactly the local-dev workflow from `docs/DEPLOYMENT.md` §2 — only the
database is remote.

## 4. Everyday use

- The honeypot is live at its Render URL the moment step 1 finishes provisioning — don't browse
  to it yourself if you want a clean "first external contact" signal.
- Re-run the admin-api/admin-web commands in step 3 whenever you want to check the dashboard;
  nothing needs to stay running between sessions except the two Render resources themselves.
- Live SSE stream, search, canaries, everything in `docs/API.md` works identically — it's the
  same code, just pointed at a remote database instead of a local one.
