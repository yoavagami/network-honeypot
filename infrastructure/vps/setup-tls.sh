#!/usr/bin/env bash
# Issues a Let's Encrypt certificate for the given domain and switches Nginx over to the
# TLS-enabled config. Requires the domain's A (and AAAA, if applicable) record already pointing
# at this host's public IP — DNS propagation can take a few minutes to a few hours.
#
# Usage: infrastructure/vps/setup-tls.sh yourdomain.example you@example.com
set -euo pipefail

DOMAIN="${1:?Usage: setup-tls.sh <domain> <email>}"
EMAIL="${2:?Usage: setup-tls.sh <domain> <email>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> Rendering Nginx TLS config for $DOMAIN"
export DOMAIN
envsubst '${DOMAIN}' < "$REPO_ROOT/infrastructure/nginx/honeypot-tls.conf" > "$REPO_ROOT/infrastructure/nginx/honeypot-tls.rendered.conf"

echo "==> Stopping Nginx to free port 80 for the ACME HTTP-01 challenge"
docker compose -f "$REPO_ROOT/docker-compose.yml" stop nginx

echo "==> Requesting certificate from Let's Encrypt (standalone mode)"
docker run --rm -p 80:80 \
  -v honeypot_certbot_certs:/etc/letsencrypt \
  certbot/certbot certonly --standalone \
  -d "$DOMAIN" --agree-tos -m "$EMAIL" -n --no-eff-email

# certbot's live/ and archive/ directories are 0700 root-only by default. nginx's container
# runs as an unprivileged, capability-dropped user (see docker-compose.yml's nginx service) for
# hardening, so without this it can never read its own certificate — confirmed live: nginx
# crash-looped with "cannot load certificate ... Permission denied" until this ran. a+X only
# grants execute on directories (needed to traverse into them), not on the key file itself.
echo "==> Making certificates readable by the unprivileged Nginx container"
docker run --rm -v honeypot_certbot_certs:/etc/letsencrypt alpine \
  chmod -R a+rX /etc/letsencrypt/live /etc/letsencrypt/archive

echo "==> Starting Nginx with TLS enabled"
docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/infrastructure/vps/docker-compose.tls.yml" \
  up -d nginx

# Lets deploy.sh detect "TLS is active" on future redeploys — without this, its rsync --delete
# wipes the rendered TLS config above (never tracked in git, only generated here) and its plain
# `docker compose up` recreates nginx without the TLS overlay, silently reverting to HTTP-only.
# Found live: exactly that happened on the first redeploy after this script ran.
grep -q '^TLS_DOMAIN=' "$REPO_ROOT/.env" && sed -i "s/^TLS_DOMAIN=.*/TLS_DOMAIN=$DOMAIN/" "$REPO_ROOT/.env" || echo "TLS_DOMAIN=$DOMAIN" >> "$REPO_ROOT/.env"

echo
echo "Done. Verify: curl -I https://$DOMAIN"
echo
echo "Certificates expire in 90 days. Set up renewal (crontab -e on the host):"
echo "  0 3 * * * docker run --rm -v honeypot_certbot_certs:/etc/letsencrypt certbot/certbot renew --quiet && docker run --rm -v honeypot_certbot_certs:/etc/letsencrypt alpine chmod -R a+rX /etc/letsencrypt/live /etc/letsencrypt/archive && docker compose -f $REPO_ROOT/docker-compose.yml -f $REPO_ROOT/infrastructure/vps/docker-compose.tls.yml restart nginx"
