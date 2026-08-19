#!/usr/bin/env bash
# Enables the "public admin" option on a VPS: the dashboard becomes reachable at
# https://yourdomain.example:8443 with no SSH tunnel, protected by the app's own login instead
# of network isolation. This is an explicit alternative to the SSH-tunnel default (docs/DEPLOYMENT.md
# §4) — run this only if you've decided that tradeoff is right for you; see
# docs/DEPLOY_RENDER.md "the tradeoff, stated plainly" for the reasoning (identical tradeoff,
# just the AWS-side implementation).
#
# Requires setup-tls.sh to have already been run for the same domain (this reuses that
# certificate rather than issuing a new one).
#
# Usage: infrastructure/vps/setup-public-admin.sh yourdomain.example
set -euo pipefail

DOMAIN="${1:?Usage: setup-public-admin.sh <domain>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! docker volume inspect honeypot_certbot_certs >/dev/null 2>&1; then
  echo "No honeypot_certbot_certs volume found — run setup-tls.sh $DOMAIN <email> first." >&2
  exit 1
fi

echo "==> Rendering admin-web's Nginx config for $DOMAIN"
export DOMAIN
envsubst '${DOMAIN}' < "$REPO_ROOT/infrastructure/nginx/admin-web-public-tls.conf" > "$REPO_ROOT/infrastructure/nginx/admin-web-public-tls.rendered.conf"

echo "==> Applying the public-admin overlay"
docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/infrastructure/vps/docker-compose.tls.yml" \
  -f "$REPO_ROOT/infrastructure/vps/docker-compose.public-admin.yml" \
  up -d admin-web

echo "==> Opening port 8443 in the firewall"
sudo ufw allow 8443/tcp

echo
echo "Done. Dashboard: https://$DOMAIN:8443"
echo
echo "If you change your mind later, close the firewall port and redeploy admin-web without this"
echo "override to go back to SSH-tunnel-only access:"
echo "  sudo ufw delete allow 8443/tcp"
echo "  docker compose -f $REPO_ROOT/docker-compose.yml up -d admin-web"
