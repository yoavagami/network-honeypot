#!/usr/bin/env bash
# Bootstraps a fresh Ubuntu/Debian VPS (DigitalOcean, Hetzner, Linode, AWS EC2 w/ Ubuntu AMI,
# etc.) to run the honeypot stack. Idempotent — safe to re-run. See docs/DEPLOYMENT.md.
#
# Usage (as a non-root sudo-capable user, run FROM the VPS itself):
#   curl -fsSL https://raw.githubusercontent.com/<you>/network-honeypot/main/infrastructure/vps/bootstrap.sh | bash
# or, if you've already cloned the repo:
#   bash infrastructure/vps/bootstrap.sh
#
# What this does NOT do (deliberately, see docs/DEPLOYMENT.md §3 checklist — do these yourself):
#   - does not create a non-root deploy user (assumes you're already running as one)
#   - does not disable SSH password auth / configure SSH keys (do this before exposing the box)
#   - does not set up TLS (see infrastructure/vps/setup-tls.sh, needs a domain pointed at this IP)
set -euo pipefail

echo "==> Updating OS packages"
sudo apt-get update -y
sudo apt-get upgrade -y

echo "==> Enabling unattended security upgrades"
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Installing Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Added $USER to the docker group — log out and back in (or run 'newgrp docker') before using docker without sudo."
fi

echo "==> Configuring firewall (ufw): allow SSH, HTTP, HTTPS only"
sudo apt-get install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose

echo "==> Installing fail2ban for SSH brute-force protection"
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban

echo
echo "Bootstrap complete. Next steps:"
echo "  1. Clone this repo onto the box if you haven't: git clone <your-fork-url> network-honeypot"
echo "  2. cd network-honeypot && cp .env.example .env && edit .env with real generated secrets"
echo "  3. (optional but recommended) point a domain's A record at this host's IP, then run:"
echo "     infrastructure/vps/setup-tls.sh yourdomain.example"
echo "  4. docker compose up -d postgres"
echo "  5. pnpm install && pnpm migrate && pnpm seed   (or run these inside a throwaway node container"
echo "     if you don't want Node/pnpm on the host — see docs/DEPLOYMENT.md)"
echo "  6. docker compose up -d --build"
echo "  7. curl -I http://localhost   (or https://yourdomain.example if TLS is set up)"
