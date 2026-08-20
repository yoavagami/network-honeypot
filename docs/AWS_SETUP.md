# AWS Setup Guide (from zero)

This assumes you have nothing yet — no AWS account, no CLI, no keys. It's split clearly into
**what only you can do** (a handful of console clicks — these genuinely can't be automated, see
below) and **what's scripted** (everything after that — one command creates the server, one
command deploys the app onto it).

## Why the split is where it is

Two things are structurally impossible for me to do on your behalf, not just inconvenient:

1. **Creating the AWS account** requires entering payment details. I don't do that for anyone,
   ever, regardless of how the request is framed — it's a hard rule, not a judgment call about
   this specific case.
2. **Creating your first IAM access key** requires being authenticated in the AWS Console as
   someone who already has permissions — there's no bootstrapping around that from the outside.

Everything past those two things — the server, the networking, the deployment — is one command
each. No console clicking required for any of it.

---

## Part 1 — Only you can do this (~10 minutes)

### 1.1 Create an AWS account
[aws.amazon.com](https://aws.amazon.com) → Create an AWS Account. Needs a credit card and phone
verification. New accounts get a free tier that covers what this guide provisions (a `t3.micro`
instance, 20GB storage) for 12 months — this project should cost close to $0 if you stay on free
tier and follow the teardown steps in Part 4 when you're done experimenting.

### 1.2 Create an IAM user for this project (don't use your root account)
1. AWS Console → search "IAM" → **Users** → **Create user**.
2. Name it something like `network-honeypot-deploy`. Don't enable console access — this user only
   needs programmatic (CLI) access.
3. **Attach policies directly** → search for and attach `AmazonEC2FullAccess`. (This is broader
   than the bare minimum this project's scripts use — they only touch EC2/key
   pairs/security-groups/addresses — but it's the pragmatic choice for a learning project over
   hand-crafting a custom least-privilege policy. Tighten it later if you want; it costs nothing
   to leave as-is for now.)
4. Create the user.

### 1.3 Generate an access key
1. Open the user you just created → **Security credentials** tab → **Create access key**.
2. Choose **Command Line Interface (CLI)** as the use case.
3. You'll get an **Access Key ID** and a **Secret Access Key** — this is the one and only time
   AWS shows you the secret. Keep the page open until the next step is done.

### 1.4 Configure the CLI

The AWS CLI is already installed on this machine. Run this yourself (it'll prompt for the two
values from step 1.3):

```
! aws configure
```

It'll also ask for a default region — `us-east-1` is a reasonable default if you have no
preference — and an output format (`json` is fine).

**That's it — everything past this point is one command each.**

---

## Part 2 — Automated: create the server

```
infrastructure/aws/provision.sh
```

This creates (and, if you re-run it, safely reuses rather than duplicates):
- An SSH key pair (private key saved to `infrastructure/aws/network-honeypot-key.pem`, gitignored
  — this is the only copy, AWS doesn't let you re-download it)
- A security group: SSH (22) open only to your current public IP, HTTP (80) and HTTPS (443) open
  to everyone (that's the point — it's a honeypot), port 8443 pre-opened for the optional public
  admin option later
- A `t3.micro` EC2 instance running Ubuntu 22.04 (override with `INSTANCE_TYPE=t4g.micro` for a
  cheaper Graviton instance once/if you're past the free tier — no code changes needed either way)
- A stable Elastic IP, so the address doesn't change if the instance restarts

It prints the instance's public IP when done. Takes 1-3 minutes.

*(This is the author's best-effort AWS CLI scripting — reasoned through carefully but not
verified against a live account. If a command errors, the error message will say which AWS
permission or resource it choked on; most likely culprit is the IAM policy from step 1.2 or a
region without a default VPC.)*

---

## Part 3 — Automated: deploy the app

```
infrastructure/aws/deploy.sh
```

This: waits for the box to be SSH-ready, installs Docker/firewall/fail2ban on it
(`infrastructure/vps/bootstrap.sh`), copies this repo to it, generates and saves real random
secrets into a `.env` on the server (only the first time — never overwrites it on a re-run), runs
database migrations and seeds synthetic data, and brings up the full stack.

It prints your admin dashboard login **once** — save it, it's not stored anywhere else, exactly
like the local dev flow.

Re-run this any time you change code locally and want to redeploy — it's idempotent (syncs the
repo, re-runs migrations, which skip anything already applied, and rebuilds containers).

**When this finishes, the honeypot is live and public.** Don't browse to it yourself if you want
a clean "first external contact" timestamp in the dashboard.

---

## Part 4 — Optional next steps

### Reach the admin dashboard
Private by default (SSH tunnel — printed at the end of `deploy.sh`), or make it public with its
own login instead:

```
ssh -N -L 8081:localhost:8081 -L 8090:localhost:8090 ubuntu@<public-ip>    # private (default)
```
```
infrastructure/vps/setup-public-admin.sh yourdomain.example                # public — needs TLS below first
```

### Add a domain + real TLS
Point a domain's A record at the printed public IP, wait for it to resolve (`dig +short
yourdomain.example`), then:
```
infrastructure/vps/setup-tls.sh yourdomain.example you@example.com
```

### Tear it all down (stop paying)
```bash
NAME=network-honeypot
REGION=us-east-1   # or whatever you configured

INSTANCE_ID=$(aws ec2 describe-instances --region $REGION --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=running,stopped" --query 'Reservations[0].Instances[0].InstanceId' --output text)
ALLOC_ID=$(aws ec2 describe-addresses --region $REGION --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text)
SG_ID=$(aws ec2 describe-security-groups --region $REGION --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text)

aws ec2 terminate-instances --region $REGION --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --region $REGION --instance-ids "$INSTANCE_ID"
aws ec2 release-address --region $REGION --allocation-id "$ALLOC_ID"
aws ec2 delete-security-group --region $REGION --group-id "$SG_ID"
aws ec2 delete-key-pair --region $REGION --key-name "$NAME"
rm -f infrastructure/aws/network-honeypot-key.pem
```
An Elastic IP costs a small hourly fee *while allocated but not attached to a running instance* —
the `release-address` step above is what stops that meter, not just terminating the instance.

## Cost estimate

`t3.micro` + 20GB gp3 + one Elastic IP, on a new account within the 12-month free tier: **~$0/mo**.
Past free tier, or on an existing account: **~$8-10/mo** (`t3.micro` ≈ $7.50/mo, storage ≈ $1.60/mo,
Elastic IP is free while attached to a running instance). Nothing else in this project incurs AWS
cost — Postgres, Nginx, the app itself all run inside the one instance. **Self-hosted Postgres by
design, not RDS** — the DB is just another container in `docker-compose.yml`, same as local dev;
provisioning it separately as a managed RDS instance was deliberately not built, since it's a
second billable service this project doesn't need.

`t3.micro` has 1GB RAM for all 5 containers combined. Checked against real measured usage (not
just the `mem_limit` caps, which are per-container ceilings, not reservations): the full stack
under light traffic uses **~220MiB total** — Postgres ~22MiB, honeypot ~90MiB, admin-api ~87MiB,
nginx ~13MiB, admin-web ~8MiB — leaving real headroom for OS/Docker overhead and traffic spikes.
Sustained scanner traffic on a live deployment will use more than this idle baseline (Postgres
cache growth, Node heap under load), which hasn't been measured yet since nothing's deployed —
but the margin here is wide enough that `t3.micro` is a reasonable default, not a stretch. If a
deployment ever does get memory-constrained, each service's `mem_limit` means Docker's OOM killer
takes down that one container (which `restart: unless-stopped` brings back) rather than locking
up the whole host.
