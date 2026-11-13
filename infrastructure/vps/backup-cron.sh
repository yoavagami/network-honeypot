#!/usr/bin/env bash
# Nightly database backup on the host — installed as a cron job (02:30) by
# infrastructure/aws/deploy.sh. Writes scripts/backup.sh's pg_dump (custom format) to ~/backups,
# OUTSIDE the synced repo dir so a redeploy can never touch it, and keeps the last
# BACKUP_KEEP_DAYS days (default 14). Copy them off the host with
# infrastructure/aws/pull-backups.sh — see docs/DEPLOYMENT.md §8.
#
# Usage: backup-cron.sh <repo-dir>
set -euo pipefail

REPO_DIR="${1:?Usage: backup-cron.sh <repo-dir>}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
cd "$REPO_DIR"
mkdir -p "$BACKUP_DIR"

echo "==> $(date -u +%Y-%m-%dT%H:%M:%SZ) backup start"
# scripts/backup.sh resolves its output dir relative to the repo root; pass an absolute-ish
# relative path that lands in $BACKUP_DIR.
REL="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$BACKUP_DIR" "$REPO_DIR")"
bash scripts/backup.sh "$REL"

# A dump that is empty or tiny means pg_dump failed part-way; say so loudly in the log.
LATEST="$(ls -t "$BACKUP_DIR"/honeypot-*.dump* 2>/dev/null | head -1 || true)"
if [ -z "$LATEST" ] || [ "$(stat -c %s "$LATEST")" -lt 10240 ]; then
  echo "!! backup looks wrong: ${LATEST:-no file} — check pg_dump output above" >&2
  exit 1
fi

find "$BACKUP_DIR" -maxdepth 1 -name 'honeypot-*.dump*' -mtime +"$KEEP_DAYS" -print -delete
echo "==> backup done: $LATEST ($(du -h "$LATEST" | cut -f1)); kept $(ls "$BACKUP_DIR"/honeypot-*.dump* | wc -l) dumps"
