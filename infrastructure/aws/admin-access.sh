#!/usr/bin/env bash
# Shows who accessed the public admin dashboard (https://<domain>:8443) — read from the
# persistent JSON access log that admin-web writes (see infrastructure/nginx/admin-web-public-tls.conf
# and docker-compose.public-admin.yml). Runs from your laptop; needs ssh access and jq.
#
# Usage:
#   infrastructure/aws/admin-access.sh                  # summary per IP + login attempts, last 7 days
#   infrastructure/aws/admin-access.sh --since 24h      # same, custom window (Nh or Nd)
#   infrastructure/aws/admin-access.sh --tail 50        # the last 50 requests, one per line
#   infrastructure/aws/admin-access.sh --download       # save the full log locally as JSON lines
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="$REPO_ROOT/infrastructure/aws/${NAME}-key.pem"

MODE="summary"
SINCE="7d"
TAIL_N=50
OUT_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --tail) MODE="tail"; TAIL_N="${2:-50}"; shift 2 || shift ;;
    --download) MODE="download"; OUT_FILE="${2:-}"; shift; [ -n "$OUT_FILE" ] && shift || true ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required (brew install jq)." >&2; exit 1; }

PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo "None")
if [ "$PUBLIC_IP" = "None" ] || [ -z "$PUBLIC_IP" ]; then
  echo "No provisioned instance found." >&2
  exit 1
fi

# Oldest rotated file first, so lines come out in time order.
fetch_log() {
  ssh -i "$KEY_FILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "ubuntu@$PUBLIC_IP" \
    "docker run --rm -v honeypot_admin_access_logs:/l:ro alpine sh -c 'cd /l && for f in \$(ls access.log.* 2>/dev/null | sort -t. -k3 -rn) access.log; do [ -f \"\$f\" ] && cat \"\$f\"; done'"
}

if [ "$MODE" = "download" ]; then
  OUT_FILE="${OUT_FILE:-admin-access-$(date +%Y%m%d-%H%M%S).jsonl}"
  fetch_log > "$OUT_FILE"
  echo "Saved $(wc -l < "$OUT_FILE" | tr -d ' ') requests to $OUT_FILE"
  exit 0
fi

LOG=$(fetch_log)
if [ -z "$LOG" ]; then
  echo "No dashboard access recorded yet."
  exit 0
fi
MY_IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '\n' || echo "")

if [ "$MODE" = "tail" ]; then
  printf '%s\n' "$LOG" | tail -n "$TAIL_N" | jq -r --arg me "$MY_IP" \
    '[.time, (.ip + (if .ip == $me then " (you)" else "" end)), (.status|tostring), .method, .uri, (.user_agent[0:70])] | @tsv' \
    | column -t -s $'\t'
  exit 0
fi

case "$SINCE" in
  *h) SINCE_TS=$(date -u -v-"${SINCE%h}"H +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "-${SINCE%h} hours" +%Y-%m-%dT%H:%M:%S) ;;
  *d) SINCE_TS=$(date -u -v-"${SINCE%d}"d +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "-${SINCE%d} days" +%Y-%m-%dT%H:%M:%S) ;;
  *) echo "--since takes Nh or Nd, e.g. 24h or 7d" >&2; exit 1 ;;
esac

WINDOW=$(printf '%s\n' "$LOG" | jq -c --arg since "$SINCE_TS" 'select(.time[0:19] >= $since)')
if [ -z "$WINDOW" ]; then
  echo "No dashboard access in the last $SINCE."
  exit 0
fi

echo "Dashboard access, last $SINCE (since $SINCE_TS UTC)"
echo
echo "== Visitors by IP"
printf '%s\n' "$WINDOW" | jq -rs --arg me "$MY_IP" '
  group_by(.ip)
  | map({
      ip: (.[0].ip + (if .[0].ip == $me then " (you)" else "" end)),
      hits: length,
      logins_ok: (map(select(.uri == "/api/auth/login" and .status == 200)) | length),
      logins_failed: (map(select(.uri == "/api/auth/login" and (.status == 401 or .status == 429))) | length),
      first: (map(.time) | min),
      last: (map(.time) | max),
      ua: (.[-1].user_agent[0:60])
    })
  | sort_by(.last) | reverse
  | (["IP", "HITS", "LOGIN_OK", "LOGIN_FAIL", "FIRST", "LAST", "USER_AGENT"] | @tsv),
    (.[] | [.ip, .hits, .logins_ok, .logins_failed, .first[0:19], .last[0:19], .ua] | @tsv)
' | column -t -s $'\t'

echo
echo "== Login attempts"
LOGINS=$(printf '%s\n' "$WINDOW" | jq -r --arg me "$MY_IP" '
  select(.uri == "/api/auth/login" and .method == "POST")
  | [.time[0:19], (.ip + (if .ip == $me then " (you)" else "" end)),
     (if .status == 200 then "success" elif .status == 401 then "wrong password" elif .status == 429 then "rate-limited" else (.status|tostring) end),
     (.user_agent[0:60])]
  | @tsv')
if [ -n "$LOGINS" ]; then
  printf 'TIME\tIP\tRESULT\tUSER_AGENT\n%s\n' "$LOGINS" | column -t -s $'\t'
else
  echo "(none)"
fi
