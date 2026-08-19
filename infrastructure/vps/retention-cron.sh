#!/usr/bin/env bash
# Runs packages/db/src/retention.ts against the running stack's Postgres — redacts
# requests.ip_raw past RAW_IP_RETENTION_DAYS, creates upcoming monthly partitions, and drops
# partitions entirely past EVENT_RETENTION_DAYS. See docs/DATA_MODEL.md §4.
#
# Installed as a daily cron job by infrastructure/aws/deploy.sh. A non-AWS VPS can install the
# same crontab line manually — see docs/DEPLOYMENT.md §8.
#
# Usage: retention-cron.sh <repo-dir>
set -euo pipefail

REPO_DIR="${1:?Usage: retention-cron.sh <repo-dir>}"
cd "$REPO_DIR"

set -a
# shellcheck disable=SC1091
source .env
set +a

# CI=true: without it, pnpm interactively prompts to confirm purging node_modules whenever the
# bind-mounted repo already has a (possibly different-platform) node_modules from a prior
# `docker compose build` — which a cron-driven, non-interactive run can never answer. Found by
# actually running this against the live dev stack, not just reading the command.
docker run --rm --network "container:$(docker compose ps -q postgres)" \
  --env-file .env -e DATABASE_URL="postgres://${POSTGRES_SUPERUSER}:${POSTGRES_SUPERUSER_PASSWORD}@localhost:5432/${POSTGRES_DB}" \
  -e CI=true \
  -v "$PWD:/app" -w /app node:22-bookworm-slim bash -c 'corepack enable && pnpm install --frozen-lockfile && pnpm retention'
