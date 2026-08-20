#!/usr/bin/env bash
# Full teardown: deletes the EC2 instance, its disk (delete-on-termination — see provision.sh),
# the Elastic IP, the security group, and the key pair. This is the ONLY way to reach literal
# $0 — see infrastructure/aws/down.sh instead if you want to keep your collected telemetry and
# just stop paying for compute/IP in the meantime.
#
# DESTRUCTIVE: the disk holds Postgres, which holds every request/event/detection the honeypot
# has ever recorded. There is no undo once instance-terminated completes, short of a backup you
# took yourself with scripts/backup.sh beforehand.
#
# Usage: infrastructure/aws/destroy.sh
#   Prompts for confirmation before doing anything, unless CONFIRM=yes is set in the environment.
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

echo "==> Checking credentials"
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "AWS credentials not configured or invalid. Run 'aws configure' first." >&2
  exit 1
}
echo "    region: $REGION"

INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  echo "No instance found tagged Name=$NAME in $REGION — nothing to destroy."
  exit 0
fi

echo
echo "This will PERMANENTLY delete:"
echo "  - instance $INSTANCE_ID and its disk (all collected telemetry — actors/requests/events/detections)"
echo "  - its Elastic IP, security group, and SSH key pair"
echo
if [ "${CONFIRM:-}" != "yes" ]; then
  read -r -p "Type 'destroy' to confirm: " ANSWER
  if [ "$ANSWER" != "destroy" ]; then
    echo "Aborted — nothing was changed."
    exit 1
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="$REPO_ROOT/infrastructure/aws/${NAME}-key.pem"

echo "==> Terminating instance"
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID"
echo "    terminated (disk went with it — delete-on-termination)"

echo "==> Releasing Elastic IP"
ALLOC_ID=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$ALLOC_ID" != "None" ] && [ -n "$ALLOC_ID" ]; then
  aws ec2 release-address --region "$REGION" --allocation-id "$ALLOC_ID" >/dev/null
  echo "    released"
else
  echo "    none allocated"
fi

echo "==> Deleting security group"
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" != "None" ] && [ -n "$SG_ID" ]; then
  aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" >/dev/null
  echo "    deleted"
else
  echo "    none found"
fi

echo "==> Deleting key pair"
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$NAME" >/dev/null 2>&1; then
  aws ec2 delete-key-pair --region "$REGION" --key-name "$NAME" >/dev/null
  rm -f "$KEY_FILE"
  echo "    deleted (AWS side and local $KEY_FILE)"
else
  echo "    none found"
fi

cat <<EOF

Destroyed. Nothing left running or billing for this project.

To stand it back up from scratch:
  infrastructure/aws/provision.sh
  infrastructure/aws/deploy.sh
(this creates a fresh instance with an empty database — none of the old telemetry survives)
EOF
