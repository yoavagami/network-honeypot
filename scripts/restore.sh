#!/usr/bin/env bash
# Restores a backup.sh dump into the running honeypot Postgres. See docs/DEPLOYMENT.md §8.
# Runs pg_restore *inside* the postgres container (via `docker compose exec`) rather than
# requiring pg_restore installed on the host — same reasoning as scripts/backup.sh.
#
# Expected sequence on a genuinely fresh box (disaster recovery, not just "oops, undo"):
#   1. docker compose up -d postgres         # fresh, empty data volume
#   2. pnpm migrate                          # recreates schema + honeypot_role/admin_api_role
#      (ensureRoles.ts recreates the scoped roles; restore below brings back their DATA,
#      not their existence — migrate must run first or the GRANTs in the dump have nothing
#      to attach to)
#   3. scripts/restore.sh <dump-file>
#
# Usage: scripts/restore.sh <dump-file>
set -euo pipefail

DUMP_FILE="${1:?Usage: restore.sh <dump-file>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.env"
set +a

if [[ "$DUMP_FILE" == *.gpg ]]; then
  echo "==> Decrypting $DUMP_FILE"
  DECRYPTED="${DUMP_FILE%.gpg}"
  gpg --yes --output "$DECRYPTED" --decrypt "$DUMP_FILE"
  DUMP_FILE="$DECRYPTED"
fi

echo "==> Restoring $DUMP_FILE into ${POSTGRES_DB:-honeypot}"
echo "    (--data-only: the target already has the correct schema from a fresh 'pnpm migrate'"
echo "    run — see step 2 above. --clean was tried and rejected: pg_dump/pg_restore cannot"
echo "    drop a partition's inherited primary-key constraint via 'ALTER TABLE ONLY <partition>"
echo "    DROP CONSTRAINT' — Postgres requires that to go through the parent partitioned table."
echo "    _migrations is truncated first because 'pnpm migrate' already wrote its own rows there"
echo "    with the same primary keys the dump has; pg_restore has no --exclude-table flag"
echo "    (that's a pg_dump-only option), so we clear the table instead and let the dump"
echo "    repopulate it — its rows are identical either way.)"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_SUPERUSER:-honeypot_owner}" -d "${POSTGRES_DB:-honeypot}" -c "TRUNCATE _migrations;"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
  pg_restore --data-only --disable-triggers --no-owner \
  -U "${POSTGRES_SUPERUSER:-honeypot_owner}" -d "${POSTGRES_DB:-honeypot}" \
  < "$DUMP_FILE"

echo "==> Restore complete."
