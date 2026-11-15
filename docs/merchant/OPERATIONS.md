# Merchant platform — operations

How the merchant platform is built, deployed and run. The API contract is in [CONTRACT.md](CONTRACT.md);
the merchant-facing guides are generated from [`docs/integrate`](../integrate).

## What runs where

```
merchant's site ──tag beacons──► nginx (uhoney.shop /v1/*, or api.uhoney.shop) ──► merchant-api ──► Postgres "merchant" db
merchant's server ──/v1/assess──┘                                                  │  (merchant_app role, RLS)
merchant users ──► admin-web /m (public dashboard :8443) ──/m/api──────────────────┤
honeypot admins ──► admin-web /merchants ──► admin-api ──/internal (token)─────────┘  (merchant_admin role)
```

| Piece | Code | Notes |
|---|---|---|
| Contract | `packages/merchant-contract` | OpenAPI + runtime schemas, contract test |
| Database | `packages/merchant-db` | Separate `merchant` database; row-level security per merchant |
| API + workers | `apps/merchant-api` | `/v1/*` public API, `/m/api/*` merchant dashboard, `/internal/*` admin, scoring + webhook + retention workers |
| Admin views | `apps/admin-api/src/routes/merchants.ts`, `apps/admin-web/src/pages/MerchantsAdmin.tsx` | All merchants, filterable by one; access-logged |
| Merchant portal | `apps/admin-web/src/pages/MerchantPortal.tsx` (`/m/*`) | Own sign-in; one merchant only |
| Guides | `docs/integrate` → `pnpm --filter @honeypot/app-merchant-api build:docs` | Served at `/docs/integrate`, `/integrate/v1/agent.md`, `/llms.txt` |

Scoring reuses `packages/detection` unchanged: merchant events are mapped to the same visit rows the honeypot
scores (`apps/merchant-api/src/scoring/visits.ts`). The tag is the honeypot's page script with a loader and a few
textual patches (`apps/merchant-api/src/tag.ts`); a test fails if a patch target disappears from `app.js`.

## Who can see what

- **Merchant users** (owner, developer, analyst) see only their merchant. Every query runs inside
  `withMerchant()`, which sets `app.merchant_id` from the session or API key; Postgres row-level security
  enforces the same rule, so a missing filter returns nothing rather than another merchant's rows.
- **Honeypot admins** (superadmin and admin) see every merchant through admin-api, with a merchant filter.
  admin-api writes `view_merchant_data` to the admin audit log for each merchant-specific view, and
  `merchant_approve` / `merchant_decline` / `merchant_status` / `merchant_invite` for actions.
- `/internal/*` answers only with `MERCHANT_INTERNAL_TOKEN` and is never routed by nginx.

## Onboarding a merchant

1. The merchant submits `https://uhoney.shop/merchants` (status `pending`).
2. An admin approves it on **Merchants** in the dashboard. Approval creates the merchant ID, a test site key,
   and a single-use owner invite link (7 days). No email is sent: copy the link to the merchant.
3. The owner accepts the invite at `/m/invite/<token>`, sets a password, accepts the terms, and lands on
   **Integration**, where they create a test secret key and follow the guide or hand it to their coding agent.
4. Live keys need a verified domain (DNS TXT `uhoney-verify=<token>` or a meta tag).

## Deploying

`infrastructure/aws/deploy.sh` does everything:

- appends the merchant secrets to the server `.env` once (`MERCHANT_*`, see `.env.example`);
- sets `MERCHANT_PUBLIC_API_URL` / `MERCHANT_TAG_BASE_URL` to `https://<TLS_DOMAIN>` and
  `MERCHANT_DASHBOARD_URL` to `https://<PUBLIC_ADMIN_DOMAIN>:8443` if unset;
- runs the merchant migration (creates the `merchant` database and the `merchant_app` / `merchant_admin`
  roles if missing);
- builds, then runs `nginx -t` against the new config before restarting anything;
- nightly backups now include `merchant-<timestamp>.dump` next to the honeypot dump.

### Optional hostnames

Everything works on the main domain. To move the API to `api.uhoney.shop`:

1. Add a CNAME `api` → `uhoney.shop` at the DNS provider.
2. On the server: `TLS_EXTRA_DOMAINS=staging.uhoney.shop,api.uhoney.shop` in `.env`, then
   `infrastructure/vps/setup-tls.sh uhoney.shop <email>` (expands the certificate and restarts the edge).
3. Set `MERCHANT_PUBLIC_API_URL=https://api.uhoney.shop` in `.env` and redeploy. The tag keeps loading from
   `uhoney.shop/v1/tag.js` and sends to the new API host.

A separate `app.uhoney.shop` for the merchant portal is not set up yet; merchants use the public dashboard
URL's `/m` path.

## Local development

```bash
# Postgres from docker compose (port 5433), then:
MERCHANT_MIGRATE_URL=postgres://honeypot_owner:…@localhost:5433/merchant \
MERCHANT_APP_DB_PASSWORD=… MERCHANT_ADMIN_DB_PASSWORD=… pnpm --filter @honeypot/merchant-db migrate
# merchant-api with the MERCHANT_* variables from .env.example:
pnpm --filter @honeypot/app-merchant-api dev
# merchant portal: admin-web dev server → http://localhost:5173/m  (talks to http://localhost:8095)
```

Tests that need Postgres run when `MERCHANT_TEST_PG_URL` points at a superuser connection (each test creates and
drops its own database):

```bash
MERCHANT_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm test
```

## Limits and known gaps (v1)

- Rate limits are in-memory per process (fine for one instance; move to Redis before scaling out).
- Network enrichment (ASN / data-centre detection) only runs when `IPINFO_TOKEN` is set.
- No reverse-DNS verification at assess time (Web Bot Auth and published IP ranges only), to keep it fast.
- TLS fingerprints (JA4) are only available for traffic through our own edge, not merchants' sites (Tier 3).
- No email sending: invite links are copied by hand.
- The merchant service shares the honeypot's server; move it to its own machine and managed Postgres before
  the first real design partner (plan, decision 5).
