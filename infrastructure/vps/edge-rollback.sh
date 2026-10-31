#!/usr/bin/env bash
# Takes the edge sensor out of the HTTPS path: stops it and lets nginx publish 443 directly again
# (its original `listen 443 ssl` server block never went away). Run on the server from the repo
# root. Undo with a normal infrastructure/aws/deploy.sh.
set -euo pipefail
COMPOSE="docker compose -f docker-compose.yml -f infrastructure/vps/docker-compose.tls.yml"
[ -f infrastructure/nginx/admin-web-public-tls.rendered.conf ] && COMPOSE="$COMPOSE -f infrastructure/vps/docker-compose.public-admin.yml"
$COMPOSE stop edge
$COMPOSE -f infrastructure/vps/docker-compose.no-edge.yml up -d nginx
echo "edge sensor stopped; nginx serving 443 directly"
