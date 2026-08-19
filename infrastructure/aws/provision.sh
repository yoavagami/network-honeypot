#!/usr/bin/env bash
# Provisions the AWS resources for the honeypot: a key pair, a security group, an EC2 instance,
# and a stable Elastic IP. Everything past "you have one IAM access key" — see docs/AWS_SETUP.md
# for what that key needs and how to get it (the one part of this that can't be automated).
#
# Idempotent: safe to re-run. Uses a fixed name ("network-honeypot") for every resource it
# creates and checks for an existing one by that name/tag before creating a new one, so re-running
# after a partial failure won't create duplicates or double-bill you.
#
# Usage: infrastructure/aws/provision.sh
# Override defaults with env vars: AWS_REGION, INSTANCE_TYPE (default t3.micro — free-tier
# eligible on a new AWS account; t4g.micro is cheaper long-term but not free-tier covered).
set -euo pipefail

NAME="network-honeypot"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-20}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY_FILE="$REPO_ROOT/infrastructure/aws/${NAME}-key.pem"

echo "==> Checking credentials"
CALLER=$(aws sts get-caller-identity --query Arn --output text 2>&1) || {
  echo "AWS credentials not configured or invalid. Run 'aws configure' first — see docs/AWS_SETUP.md." >&2
  exit 1
}
echo "    authenticated as: $CALLER"
echo "    region: $REGION"
echo "    instance type: $INSTANCE_TYPE"

# ----------------------------------------------------------------------------
# Default VPC / subnet — no custom networking, matches docs/ARCHITECTURE.md's
# "simplest architecture that provides excellent visibility" reasoning.
# ----------------------------------------------------------------------------
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
  echo "No default VPC found in $REGION. Create one (aws ec2 create-default-vpc) or pick a region that has one." >&2
  exit 1
fi
SUBNET_ID=$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" --query 'Subnets[0].SubnetId' --output text)
echo "    VPC: $VPC_ID, subnet: $SUBNET_ID"

# ----------------------------------------------------------------------------
# Key pair
# ----------------------------------------------------------------------------
echo "==> Key pair"
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$NAME" >/dev/null 2>&1; then
  if [ ! -f "$KEY_FILE" ]; then
    echo "A key pair named '$NAME' already exists in AWS, but $KEY_FILE isn't present locally." >&2
    echo "AWS never lets you re-download private key material — either find your saved copy, or" >&2
    echo "delete the AWS key pair (aws ec2 delete-key-pair --key-name $NAME --region $REGION) and re-run this script." >&2
    exit 1
  fi
  echo "    reusing existing key pair: $NAME"
else
  aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" --query 'KeyMaterial' --output text > "$KEY_FILE"
  chmod 400 "$KEY_FILE"
  echo "    created key pair, saved to $KEY_FILE"
fi

# ----------------------------------------------------------------------------
# Security group — SSH restricted to your current public IP, HTTP/HTTPS open.
# 8443 is included pre-emptively for the optional public-admin deploy option
# (infrastructure/vps/setup-public-admin.sh) — it's inert until that script's own
# ufw rule + Nginx config actually turn it on; see docs/AWS_SETUP.md.
# ----------------------------------------------------------------------------
echo "==> Security group"
MY_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID=$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description "network-honeypot" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description='SSH from provisioning machine'}]" \
    "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description='honeypot HTTP'}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0,Description='honeypot HTTPS'}]" \
    "IpProtocol=tcp,FromPort=8443,ToPort=8443,IpRanges=[{CidrIp=0.0.0.0/0,Description='optional public-admin dashboard'}]"
  echo "    created security group: $SG_ID (SSH allowed only from $MY_IP)"
else
  echo "    reusing existing security group: $SG_ID"
  echo "    if your IP has changed since it was created, SSH may fail — see docs/AWS_SETUP.md"
  echo "    for how to update the rule (aws ec2 authorize/revoke-security-group-ingress)."
fi

# ----------------------------------------------------------------------------
# AMI — latest Ubuntu 22.04 LTS, arch matched to the chosen instance type.
# ----------------------------------------------------------------------------
echo "==> Finding latest Ubuntu 22.04 LTS AMI"
case "$INSTANCE_TYPE" in
  t4g.*|m6g.*|c6g.*|r6g.*) ARCH="arm64" ;;
  *) ARCH="amd64" ;;
esac
AMI_ID=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-${ARCH}-server-*" "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
echo "    $AMI_ID ($ARCH)"

# ----------------------------------------------------------------------------
# Instance
# ----------------------------------------------------------------------------
echo "==> EC2 instance"
INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo "None")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$NAME" \
    --security-group-ids "$SG_ID" \
    --subnet-id "$SUBNET_ID" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${VOLUME_SIZE_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "    launched: $INSTANCE_ID"
  echo "    waiting for it to enter 'running' state..."
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
else
  echo "    reusing existing instance: $INSTANCE_ID"
  STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name' --output text)
  if [ "$STATE" = "stopped" ]; then
    echo "    it's stopped — starting it"
    aws ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
    aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
  fi
fi

# ----------------------------------------------------------------------------
# Elastic IP — stable address across stop/start.
# ----------------------------------------------------------------------------
echo "==> Elastic IP"
ALLOC_ID=$(aws ec2 describe-addresses --region "$REGION" --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo "None")
if [ "$ALLOC_ID" = "None" ] || [ -z "$ALLOC_ID" ]; then
  ALLOC_ID=$(aws ec2 allocate-address --region "$REGION" --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query 'AllocationId' --output text)
fi
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
PUBLIC_IP=$(aws ec2 describe-addresses --region "$REGION" --allocation-ids "$ALLOC_ID" --query 'Addresses[0].PublicIp' --output text)

echo
echo "==> Waiting for SSH to accept connections (can take ~30-60s after first boot)"
for i in $(seq 1 30); do
  if ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes ubuntu@"$PUBLIC_IP" true 2>/dev/null; then
    echo "    SSH is up"
    break
  fi
  sleep 5
done

cat <<EOF

Provisioned.
  Instance ID: $INSTANCE_ID
  Public IP:   $PUBLIC_IP
  SSH key:     $KEY_FILE
  Region:      $REGION

  ssh -i "$KEY_FILE" ubuntu@$PUBLIC_IP

Next: infrastructure/aws/deploy.sh
EOF
