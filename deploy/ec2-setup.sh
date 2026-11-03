#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 instance for urja-api.
# Installs Docker + the Compose plugin, adds 2 GB of swap, and lets the
# current user run docker without sudo. Safe to run more than once.
#
#   bash deploy/ec2-setup.sh
#   # then log out and back in (for the docker group), and see docs/DEPLOY_AWS.md
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this as the normal user (ubuntu), not root; it uses sudo where needed." >&2
  exit 1
fi

echo "==> Installing Docker and the Compose plugin"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git curl
sudo systemctl enable --now docker

echo "==> Letting $USER run docker without sudo"
sudo usermod -aG docker "$USER"

if ! swapon --show | grep -q '/swapfile'; then
  echo "==> Adding 2 GB swap (headroom for the TypeScript build on small instances)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
else
  echo "==> Swap already present"
fi

echo "==> Checking the portal is reachable from this instance"
if curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://urja-ops.flockenergy.tech/login; then
  echo "    portal reachable"
else
  echo "    WARNING: could not reach the portal from here; /ready will stay 503 until it is" >&2
fi

docker_version="$(docker --version 2>/dev/null || sudo docker --version)"
compose_version="$(docker compose version 2>/dev/null || sudo docker compose version)"
echo
echo "Done: $docker_version | $compose_version"
echo "Next: log out and back in (so 'docker' works without sudo), then:"
echo "  cd urja-api && cp .env.example .env && nano .env && chmod 600 .env"
echo "  docker compose up -d --build"
