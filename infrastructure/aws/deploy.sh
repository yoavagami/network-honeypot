#!/usr/bin/env bash
# Deploys the honeypot stack onto the instance infrastructure/aws/provision.sh created — this
# automates docs/DEPLOYMENT.md §3.2 end to end from your laptop instead of you SSHing in and
# typing each command. Idempotent: safe to re-run any time you've pulled/changed code locally —
# it syncs the repo, re-runs migrations (skips already-applied ones), reseeds (idempotent —
# packages/db/src/... uses ON CONFLICT DO NOTHING), and rebuilds/restarts containers.
#
# What gets deployed is exactly the checked-out commit (git archive HEAD) — never the working
# tree. Untracked and git-ignored files (SDK/, backups/, local notes) can't reach the server,
# and the script refuses to run with uncommitted changes to tracked files, since those would
# silently not be deployed. Found live: rsyncing the working tree shipped an ignored third-party
# folder and planning notes, and its --delete wiped a server-side backups/ dir.
#
# Usage: infrastructure/aws/deploy.sh
#   DEPLOY_ALLOW_DIRTY=1   deploy HEAD anyway when tracked files have uncommitted changes
#   DEPLOY_KEY_FILE=path   SSH key (default: infrastructure/aws/network-honeypot-key.pem in this
#                          checkout, else in the main checkout when run from a git worktree)
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR="network-honeypot"

# ---- what to deploy: the committed HEAD, nothing else
if ! git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null; then
  echo "Not a git checkout with a commit — deploy needs one (it ships git archive HEAD)." >&2
  exit 1
fi
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] && [ "${DEPLOY_ALLOW_DIRTY:-}" != "1" ]; then
  echo "Refusing to deploy: tracked files have uncommitted changes (they would NOT be deployed):" >&2
  git -C "$REPO_ROOT" status --short --untracked-files=no >&2
  echo "Commit them, or re-run with DEPLOY_ALLOW_DIRTY=1 to deploy HEAD as it is." >&2
  exit 1
fi
DEPLOY_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
DEPLOY_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"

# ---- SSH key: never in git (*.pem is ignored), so a worktree or fresh clone looks in the main checkout
KEY_FILE="${DEPLOY_KEY_FILE:-$REPO_ROOT/infrastructure/aws/${NAME}-key.pem}"
if [ ! -f "$KEY_FILE" ]; then
  MAIN_ROOT="$(cd "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
  KEY_FILE="$MAIN_ROOT/infrastructure/aws/${NAME}-key.pem"
fi
[ -f "$KEY_FILE" ] || { echo "SSH key not found ($KEY_FILE). Set DEPLOY_KEY_FILE." >&2; exit 1; }

EXPORT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPORT_DIR"' EXIT
git -C "$REPO_ROOT" archive --format=tar HEAD | tar -x -C "$EXPORT_DIR"

PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo "None")
if [ "$PUBLIC_IP" = "None" ] || [ -z "$PUBLIC_IP" ]; then
  echo "No provisioned instance found. Run infrastructure/aws/provision.sh first." >&2
  exit 1
fi
SSH="ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new ubuntu@$PUBLIC_IP"

echo "==> Target: $PUBLIC_IP — deploying $DEPLOY_BRANCH @ ${DEPLOY_SHA:0:12}"

echo "==> Bootstrapping the host (Docker, firewall, fail2ban — idempotent)"
rsync -az -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new" \
  "$EXPORT_DIR/infrastructure/vps/bootstrap.sh" "ubuntu@$PUBLIC_IP:/tmp/bootstrap.sh"
$SSH "bash /tmp/bootstrap.sh"

echo "==> Syncing the repo"
$SSH "mkdir -p $REMOTE_DIR"
# --exclude .env matters: without it this ships your LOCAL dev .env (DB passwords, session
# secrets, whatever local GEOLOCATION_ENABLED/IPINFO_TOKEN you have set) to the remote box
# instead of letting it generate its own unique ones below — found live, this also silently
# broke the admin password generation (an empty SEED_ADMIN_PASSWORD= from a local .env reads as
# "configured" to seed.ts's `??` check, so it skipped generating a random one).
# Source is the git export, so only committed files exist on the left. --delete removes stale
# files on the server; the excludes are server-side state that --delete must never touch
# (excluded paths are protected from deletion): secrets, dependencies, DB data, logs, local
# backups, rendered Nginx configs and the deploy marker.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude pgdata --exclude '*.pem' --exclude .env \
  --exclude backups --exclude '*.log' --exclude '*.rendered.conf' --exclude .deployed-commit \
  -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new" \
  "$EXPORT_DIR/" "ubuntu@$PUBLIC_IP:$REMOTE_DIR/"
# Records what is running, so "is the server on commit X?" is one cat away.
$SSH "printf '%s\\n' 'commit=$DEPLOY_SHA' 'branch=$DEPLOY_BRANCH' \"deployed_at=\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > $REMOTE_DIR/.deployed-commit"

echo "==> Ensuring .env exists on the host (generated once, never overwritten on redeploy)"
if ! $SSH "test -f $REMOTE_DIR/.env"; then
  echo "    generating secrets"
  TMP_ENV=$(mktemp)
  {
    # -hex, not -base64: base64 output can contain /, +, = which break unescaped inside a
    # postgres:// URL's userinfo section (confirmed live: a HONEYPOT_DB_PASSWORD containing "/"
    # crashed the honeypot container with `TypeError: Invalid URL` in postgres.js). Hex is
    # alphanumeric-only, always URL-safe, and used uniformly here (not just for the DB passwords)
    # so this class of bug can't resurface if any of these secrets end up in a URL later.
    echo "POSTGRES_SUPERUSER=honeypot_owner"
    echo "POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -hex 24)"
    echo "POSTGRES_DB=honeypot"
    echo "HONEYPOT_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "ADMIN_API_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "HONEYPOT_CRM_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "CRM_SEARCH_VULNERABLE=false"
    echo "BACKDOOR_BAIT_ENABLED=false"
    echo "WP_INSTALL_BAIT_ENABLED=false"
    echo "IP_HASH_SECRET=$(openssl rand -hex 24)"
    echo "COOKIE_SECRET=$(openssl rand -hex 24)"
    echo "SESSION_SECRET=$(openssl rand -hex 24)"
    echo "LAB_LINK_SECRET=$(openssl rand -hex 24)"
    echo "ADMIN_WEB_ORIGIN=http://localhost:8081"
    echo "ADMIN_API_PUBLIC_URL=http://localhost:8090"
    echo "SEED_ADMIN_USERNAME=admin"
    SEED_PASSWORD="$(openssl rand -hex 18)"
    echo "SEED_ADMIN_PASSWORD=${SEED_PASSWORD}"
    echo "RAW_IP_RETENTION_DAYS=7"
    echo "EVENT_RETENTION_DAYS=90"
    echo "GEOLOCATION_ENABLED=false"
    echo "LOG_LEVEL=info"
  } > "$TMP_ENV"
  scp -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new "$TMP_ENV" "ubuntu@$PUBLIC_IP:$REMOTE_DIR/.env"
  rm -f "$TMP_ENV"
  echo
  echo "    Admin dashboard login generated — SAVE THIS, it is not shown again:"
  echo "      username: admin"
  echo "      password: ${SEED_PASSWORD}"
  echo
else
  echo "    .env already present, leaving it alone"
  # Secrets added after the first deploy are appended once, never rotated (rotating
  # LAB_LINK_SECRET would invalidate every lab link already handed out).
  if ! $SSH "grep -q '^LAB_LINK_SECRET=' $REMOTE_DIR/.env"; then
    echo "    adding LAB_LINK_SECRET (signed lab links)"
    $SSH "echo LAB_LINK_SECRET=\$(openssl rand -hex 24) >> $REMOTE_DIR/.env"
  fi
  # Minted lab links are full URLs only when the site's public URL is known.
  TLS_FOR_URL=$($SSH "grep '^TLS_DOMAIN=' $REMOTE_DIR/.env 2>/dev/null | cut -d= -f2" || echo "")
  if [ -n "$TLS_FOR_URL" ] && ! $SSH "grep -q '^PUBLIC_SITE_URL=' $REMOTE_DIR/.env"; then
    echo "    adding PUBLIC_SITE_URL=https://$TLS_FOR_URL (clickable lab links)"
    $SSH "echo PUBLIC_SITE_URL=https://$TLS_FOR_URL >> $REMOTE_DIR/.env"
  fi
fi

echo "==> Starting Postgres"
$SSH "cd $REMOTE_DIR && docker compose up -d postgres"
$SSH "cd $REMOTE_DIR && for i in \$(seq 1 30); do docker compose exec -T postgres pg_isready -U honeypot_owner -d honeypot >/dev/null 2>&1 && break; sleep 2; done"

echo "==> Running migrations + seed"
# CI=true: without it, pnpm interactively prompts to confirm purging node_modules if the
# bind-mounted repo dir already has one from a prior run — which a non-interactive SSH command
# can never answer. Found by actually running the equivalent retention-cron.sh command locally,
# not just reading it — see infrastructure/vps/retention-cron.sh.
$SSH "cd $REMOTE_DIR && set -a && source .env && set +a && \
  docker run --rm --network container:\$(docker compose ps -q postgres) \
    --env-file .env -e DATABASE_URL=\"postgres://\${POSTGRES_SUPERUSER}:\${POSTGRES_SUPERUSER_PASSWORD}@localhost:5432/\${POSTGRES_DB}\" \
    -e CI=true \
    -v \$PWD:/app -w /app node:22-bookworm-slim bash -c 'corepack enable && pnpm install --frozen-lockfile && pnpm migrate && pnpm seed'"

echo "==> Backfilling stored visit scores (idempotent; the honeypot's worker keeps them current)"
# visit_scores (migrations/0012) is what the Agents list reads. Rescore the last 30 days (the
# list's widest range) once per deploy so it's complete and reflects any weight change.
$SSH "cd $REMOTE_DIR && set -a && source .env && set +a && \
  docker run --rm --network container:\$(docker compose ps -q postgres) \
    --env-file .env -e DATABASE_URL=\"postgres://honeypot_role:\${HONEYPOT_DB_PASSWORD}@localhost:5432/\${POSTGRES_DB}\" \
    -e CRM_DATABASE_URL=unused -e CI=true \
    -v \$PWD:/app -w /app node:22-bookworm-slim bash -c 'corepack enable && pnpm rescore --days 30'" \
  || echo "    WARNING: rescore failed — the Agents list fills in as the worker scores new activity"

echo "==> Installing daily cron jobs (retention 03:00, database backup 02:30)"
$SSH "chmod +x $REMOTE_DIR/infrastructure/vps/retention-cron.sh $REMOTE_DIR/infrastructure/vps/backup-cron.sh"
$SSH "(crontab -l 2>/dev/null | grep -v 'retention-cron.sh'; echo \"0 3 * * * \\\$HOME/$REMOTE_DIR/infrastructure/vps/retention-cron.sh \\\$HOME/$REMOTE_DIR >> \\\$HOME/$REMOTE_DIR/retention.log 2>&1\") | crontab -"
# Backups go to ~/backups, outside the synced repo dir, and keep 14 days; copy them off the
# host with infrastructure/aws/pull-backups.sh (docs/DEPLOYMENT.md §8).
$SSH "(crontab -l 2>/dev/null | grep -v 'backup-cron.sh'; echo \"30 2 * * * \\\$HOME/$REMOTE_DIR/infrastructure/vps/backup-cron.sh \\\$HOME/$REMOTE_DIR >> \\\$HOME/backups/backup.log 2>&1\") | crontab -"
$SSH "mkdir -p \$HOME/backups"

# If setup-tls.sh has ever been run, .env carries TLS_DOMAIN and the rsync --delete above just
# wiped infrastructure/nginx/honeypot-tls.rendered.conf (generated at TLS-setup time, never
# tracked in git) — regenerate it and use the TLS compose overlay instead of the plain one, or
# every redeploy silently reverts the site to HTTP-only. Found live: exactly that happened on
# the first redeploy after TLS was set up.
TLS_DOMAIN=$($SSH "grep '^TLS_DOMAIN=' $REMOTE_DIR/.env 2>/dev/null | cut -d= -f2" || echo "")

echo "==> Building and starting the full stack"
if [ -n "$TLS_DOMAIN" ]; then
  echo "    TLS active for $TLS_DOMAIN — regenerating rendered Nginx config"
  $SSH "cd $REMOTE_DIR && export DOMAIN=$TLS_DOMAIN && envsubst '\${DOMAIN}' < infrastructure/nginx/honeypot-tls.conf > infrastructure/nginx/honeypot-tls.rendered.conf"
  COMPOSE="docker compose -f docker-compose.yml -f infrastructure/vps/docker-compose.tls.yml"
  # Same failure mode for the public dashboard: rsync --delete wipes its rendered config too, and
  # without the overlay admin-web silently falls back to localhost-only. setup-public-admin.sh
  # records PUBLIC_ADMIN_DOMAIN in .env so redeploys can restore it.
  PUBLIC_ADMIN_DOMAIN=$($SSH "grep '^PUBLIC_ADMIN_DOMAIN=' $REMOTE_DIR/.env 2>/dev/null | cut -d= -f2" || echo "")
  if [ -n "$PUBLIC_ADMIN_DOMAIN" ]; then
    echo "    public admin active for $PUBLIC_ADMIN_DOMAIN — regenerating its Nginx config"
    $SSH "cd $REMOTE_DIR && export DOMAIN=$PUBLIC_ADMIN_DOMAIN && envsubst '\${DOMAIN}' < infrastructure/nginx/admin-web-public-tls.conf > infrastructure/nginx/admin-web-public-tls.rendered.conf"
    COMPOSE="$COMPOSE -f infrastructure/vps/docker-compose.public-admin.yml"
  fi
else
  # -f ...override.yml republishes nginx on host port 80 (base docker-compose.yml uses 8080, for
  # local dev) — see infrastructure/aws/docker-compose.override.yml for why. Without it nothing
  # listens on the port provision.sh's security group actually opens publicly.
  COMPOSE="docker compose -f docker-compose.yml -f infrastructure/aws/docker-compose.override.yml"
fi
$SSH "cd $REMOTE_DIR && $COMPOSE up -d --build"
# Nginx's config files are single-file bind mounts. rsync replaces each changed file with a new
# inode, but a running container keeps the old one mounted, so a changed proxy_params_*.conf
# silently doesn't apply (`nginx -s reload` re-reads the stale copy). Found live: the
# X-HP-Edge blanking rule stayed inactive until nginx was restarted.
$SSH "cd $REMOTE_DIR && $COMPOSE restart nginx"

echo
echo "==> Verifying"
VERIFY_URL="http://localhost/"
[ -n "$TLS_DOMAIN" ] && VERIFY_URL="https://localhost/ -k --resolve $TLS_DOMAIN:443:127.0.0.1"
for i in $(seq 1 15); do
  CODE=$($SSH "curl -sS -o /dev/null -w '%{http_code}' $VERIFY_URL" || echo "000")
  [ "$CODE" != "000" ] && [ "$CODE" != "502" ] && break
  sleep 2
done
echo "honeypot: $CODE"

PUBLIC_URL="http://$PUBLIC_IP/"
[ -n "$TLS_DOMAIN" ] && PUBLIC_URL="https://$TLS_DOMAIN/"

cat <<EOF

Deployed $DEPLOY_BRANCH @ $DEPLOY_SHA
  Public honeypot: $PUBLIC_URL
$([ -z "$TLS_DOMAIN" ] && echo "  (add a domain + infrastructure/vps/setup-tls.sh for HTTPS — see docs/AWS_SETUP.md)")

  Admin dashboard (Option A — SSH tunnel, private by default):
    ssh -i "$KEY_FILE" -N -L 8081:localhost:8081 -L 8090:localhost:8090 ubuntu@$PUBLIC_IP
    then browse http://localhost:8081

Don't browse to the public honeypot URL yourself if you want a clean "first external contact"
signal in the dashboard.
EOF
