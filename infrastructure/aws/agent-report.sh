#!/usr/bin/env bash
# Prints the agent-sensing report (scripts/agent-report.sql) from the live database.
# Usage: infrastructure/aws/agent-report.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="$REPO_ROOT/infrastructure/aws/network-honeypot-key.pem"
HOST="ubuntu@${HONEYPOT_HOST:-34.193.16.150}"
scp -q -i "$KEY" "$REPO_ROOT/scripts/agent-report.sql" "$HOST:/tmp/agent-report.sql"
ssh -i "$KEY" "$HOST" 'cd ~/network-honeypot && docker compose exec -T postgres psql -U honeypot_owner -d honeypot -q < /tmp/agent-report.sql'
