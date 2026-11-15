#!/usr/bin/env bash
# Backs up the running honeypot Postgres — see docs/DEPLOYMENT.md §8. Uses pg_dump's custom
# format (compressed, restorable with pg_restore, safe to restore into a differently-named
# database/role setup — unlike a plain SQL dump it doesn't hardcode the original owner).
#
# Usage: scripts/backup.sh [output-dir]   (default: ./backups)
set -euo pipefail

OUTPUT_DIR="${1:-backups}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$REPO_ROOT/$OUTPUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$REPO_ROOT/$OUTPUT_DIR/honeypot-${TIMESTAMP}.dump"

set -a
# shellcheck disable=SC1091
source "$REPO_ROOT/.env"
set +a

echo "==> Dumping database (custom format) to $OUT_FILE"
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
  pg_dump -U "${POSTGRES_SUPERUSER:-honeypot_owner}" -d "${POSTGRES_DB:-honeypot}" --format=custom \
  > "$OUT_FILE"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "==> Done: $OUT_FILE ($SIZE)"

# Merchant platform database (docs/merchant/OPERATIONS.md), when it exists.
MERCHANT_FILE="$REPO_ROOT/$OUTPUT_DIR/merchant-${TIMESTAMP}.dump"
if docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres psql -U "${POSTGRES_SUPERUSER:-honeypot_owner}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'merchant'" | grep -q 1; then
  echo "==> Dumping merchant database to $MERCHANT_FILE"
  docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
    pg_dump -U "${POSTGRES_SUPERUSER:-honeypot_owner}" -d merchant --format=custom > "$MERCHANT_FILE"
  if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
    gpg --yes --output "${MERCHANT_FILE}.gpg" --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$MERCHANT_FILE" && rm "$MERCHANT_FILE"
  fi
fi

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  echo "==> Encrypting for $BACKUP_GPG_RECIPIENT"
  gpg --yes --output "${OUT_FILE}.gpg" --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$OUT_FILE"
  rm "$OUT_FILE"
  echo "==> Encrypted: ${OUT_FILE}.gpg"
  echo "Move this off the host — see docs/DEPLOYMENT.md §3 checklist ('encrypted, off-host storage')."
else
  echo "No BACKUP_GPG_RECIPIENT set — dump left unencrypted at $OUT_FILE. Fine for a local drill;"
  echo "set BACKUP_GPG_RECIPIENT and move backups off-host for real production use."
fi
