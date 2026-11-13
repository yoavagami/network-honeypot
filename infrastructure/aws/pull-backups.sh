#!/usr/bin/env bash
# Copies the host's nightly database dumps (~/backups, see infrastructure/vps/backup-cron.sh)
# to this machine's <main checkout>/backups (git-ignored), so a copy exists off the server. Only new files
# are transferred; nothing is deleted locally. Run it by hand, or on a schedule from your laptop
# (docs/DEPLOYMENT.md §8).
#
# Usage: infrastructure/aws/pull-backups.sh [local-dir]   (default: <main checkout>/backups)
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The main checkout, even when this runs from a git worktree: that's where the SSH key lives, and
# backups must not land in a worktree that gets deleted.
MAIN_ROOT="$(cd "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
KEY_FILE="${DEPLOY_KEY_FILE:-$MAIN_ROOT/infrastructure/aws/${NAME}-key.pem}"
LOCAL_DIR="${1:-$MAIN_ROOT/backups}"

PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].PublicIp' --output text)
mkdir -p "$LOCAL_DIR"
rsync -az --ignore-existing -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new" \
  "ubuntu@$PUBLIC_IP:backups/honeypot-*.dump*" "$LOCAL_DIR/"
echo "==> Local copies in $LOCAL_DIR:"
ls -lh "$LOCAL_DIR" | tail -n +2
