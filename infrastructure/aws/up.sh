#!/usr/bin/env bash
# Resumes a deployment paused with infrastructure/aws/down.sh: starts the stopped instance,
# allocates a fresh Elastic IP (the old one was released to stop it billing while paused — see
# down.sh's header for why), and waits for the stack to actually answer requests before handing
# back control. Postgres data and everything else on disk survived the pause untouched.
#
# This is for resuming a PAUSED deployment, not creating a new one — if no instance exists yet,
# run infrastructure/aws/provision.sh then infrastructure/aws/deploy.sh instead.
#
# Idempotent: safe to re-run. If the instance is already running, it skips straight to making
# sure the app itself is up.
#
# Usage: infrastructure/aws/up.sh
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="$REPO_ROOT/infrastructure/aws/${NAME}-key.pem"
REMOTE_DIR="network-honeypot"

echo "==> Checking credentials"
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "AWS credentials not configured or invalid. Run 'aws configure' first." >&2
  exit 1
}
echo "    region: $REGION"

echo "==> Finding the instance"
INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "No instance found tagged Name=$NAME in $REGION." >&2
  echo "This script resumes a paused deployment — for a fresh one, run provision.sh then deploy.sh." >&2
  exit 1
fi

if [ ! -f "$KEY_FILE" ]; then
  echo "SSH key not found at $KEY_FILE — can't verify the app comes back up without it." >&2
  exit 1
fi

STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)
echo "    instance: $INSTANCE_ID (currently $STATE)"

if [ "$STATE" = "stopped" ] || [ "$STATE" = "stopping" ]; then
  echo "==> Starting it"
  aws ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
  echo "    waiting for 'running'..."
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
  echo "    waiting for status checks to pass (so SSH is actually reachable, not just 'running')..."
  aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$INSTANCE_ID"
  echo "    up"
else
  echo "    already running"
fi

echo "==> Elastic IP"
ALLOC_ID=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$ALLOC_ID" = "None" ] || [ -z "$ALLOC_ID" ]; then
  ALLOC_ID=$(aws ec2 allocate-address --region "$REGION" --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query 'AllocationId' --output text)
  echo "    allocated a new one: $ALLOC_ID"
else
  echo "    reusing already-allocated: $ALLOC_ID"
fi
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)
echo "    public IP: $PUBLIC_IP"

echo "==> Waiting for SSH (can take ~30-60s after a cold start)"
for i in $(seq 1 30); do
  if ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes ubuntu@"$PUBLIC_IP" true 2>/dev/null; then
    echo "    SSH is up"
    break
  fi
  sleep 5
done
SSH="ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new ubuntu@$PUBLIC_IP"

echo "==> Making sure the app stack is actually up"
# docker's restart:unless-stopped policy plus the Docker daemon starting on boot should already
# bring every container back on their own — this is a verify-don't-assume safety net, not the
# primary mechanism, matching how this project treats every other "should just work" claim.
$SSH "cd $REMOTE_DIR && docker compose up -d" || echo "    warning: couldn't reach docker compose over SSH yet — the box may still be finishing boot. Try again in a minute." >&2
sleep 3
HEALTH=$($SSH "curl -sS -o /dev/null -w '%{http_code}' http://localhost:8080/" 2>/dev/null || echo "unreachable")

cat <<EOF

Resumed.
  Public honeypot: http://$PUBLIC_IP/  (health check: $HEALTH)
  Admin dashboard (SSH tunnel):
    ssh -i "$KEY_FILE" -N -L 8081:localhost:8081 -L 8090:localhost:8090 ubuntu@$PUBLIC_IP
    then browse http://localhost:8081

  This IP is NEW — if you had a domain pointed at the old one, update its DNS A record now.
  (TLS certs from setup-tls.sh are tied to the domain, not the IP, so they're still valid once
  DNS catches up — no need to re-run setup-tls.sh.)
EOF
