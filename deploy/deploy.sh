#!/usr/bin/env bash
# Deploys the latest main on the EC2 host. Run by GitHub Actions over SSH
# (.github/workflows/deploy.yml), or by hand: bash deploy/deploy.sh
#
# The GitHub key on the server is locked to this script in ~/.ssh/authorized_keys
# (command="bash /home/ubuntu/urja-api/deploy/deploy.sh",...), so even with that
# key nobody can run anything else on the machine.
set -euo pipefail

cd "$(dirname "$0")/.."
echo "== $(date -u +%FT%TZ) deploying $(pwd)"

# --ff-only: refuses if someone edited files on the server, instead of overwriting them.
git pull --ff-only origin main
echo "== now at $(git log -1 --format='%h %s')"

docker compose up -d --build --remove-orphans

# Wait until the API is up and the catalog is loaded (up to 90 s).
for i in $(seq 1 45); do
  if curl -fsS http://localhost/ready > /dev/null 2>&1; then
    echo "== ready after $((i * 2)) s"
    curl -fsS http://localhost/health; echo
    docker image prune -f > /dev/null
    exit 0
  fi
  sleep 2
done

echo "== API did not become ready; recent logs:" >&2
docker compose logs --tail 50 api >&2
exit 1
