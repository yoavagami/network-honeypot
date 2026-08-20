#!/usr/bin/env bash
# Pauses the AWS deployment to minimize cost, WITHOUT destroying it — the instance, its disk
# (and everything on it: Postgres data, the honeypot's collected telemetry), the key pair, and
# the security group all survive. Bring it back with infrastructure/aws/up.sh.
#
# What this does and why:
#   1. Stops the EC2 instance — this is what actually stops paying for compute (the ~$7.50/mo
#      majority of the running cost). The 20GB gp3 EBS volume stays attached and keeps billing
#      at its own small rate (~$1.60/mo) the whole time the instance exists — that's the price
#      of not losing your data. There's no way to hit literal $0 short of the full teardown in
#      docs/AWS_SETUP.md's "Tear it all down" section, which deletes the disk too.
#   2. Releases the Elastic IP. Since Feb 2024, AWS bills ~$0.005/hr (~$3.60/mo) for an Elastic
#      IP whether it's attached to a running instance or not — provision.sh's original "keep the
#      EIP allocated across stop/start for a stable address" behavior is fine for pausing for a
#      few minutes, but silently keeps billing during a real pause. Releasing it here is what
#      actually gets you close to $0. The trade-off: the public IP WILL be different after
#      up.sh — if you pointed a domain at it (setup-tls.sh), you'll need to update the DNS A
#      record after bringing it back up.
#
# Idempotent: safe to re-run. If the instance is already stopped and/or the EIP already
# released, it says so and moves on rather than erroring.
#
# Usage: infrastructure/aws/down.sh
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

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
  echo "No instance found tagged Name=$NAME in $REGION — nothing to stop." >&2
  exit 1
fi

STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)
echo "    instance: $INSTANCE_ID (currently $STATE)"

if [ "$STATE" = "running" ] || [ "$STATE" = "pending" ]; then
  echo "==> Stopping it"
  aws ec2 stop-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
  echo "    waiting for it to reach 'stopped'..."
  aws ec2 wait instance-stopped --region "$REGION" --instance-ids "$INSTANCE_ID"
  echo "    stopped"
else
  echo "    already stopped, nothing to do here"
fi

echo "==> Releasing the Elastic IP"
ALLOC_ID=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$ALLOC_ID" = "None" ] || [ -z "$ALLOC_ID" ]; then
  echo "    no Elastic IP allocated for $NAME — nothing to release"
else
  ASSOC_ID=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" --query 'Addresses[0].AssociationId' --output text 2>/dev/null || echo "None")
  if [ "$ASSOC_ID" != "None" ] && [ -n "$ASSOC_ID" ]; then
    aws ec2 disassociate-address --region "$REGION" --association-id "$ASSOC_ID" >/dev/null
  fi
  aws ec2 release-address --region "$REGION" --allocation-id "$ALLOC_ID" >/dev/null
  echo "    released ($ALLOC_ID)"
fi

cat <<EOF

Paused.
  Instance:  $INSTANCE_ID (stopped)
  Elastic IP: released — next up.sh run will get a NEW public IP

  Remaining cost while paused: ~\$1.60/mo (the 20GB gp3 disk — this is what keeps your
  Postgres data, the honeypot's collected telemetry, and secrets intact). Compute and the
  Elastic IP are no longer billing.

  If you have a domain pointed at the old IP, its DNS A record will need updating after
  the next infrastructure/aws/up.sh run prints the new one.

Bring it back: infrastructure/aws/up.sh
EOF
