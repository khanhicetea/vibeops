#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "NGINX ACME module renews managed certificates automatically."
if docker compose ps --services --filter status=running 2>/dev/null | grep -qx nginx; then
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  echo "Reloaded nginx."
else
  echo "nginx container is not running."
fi
