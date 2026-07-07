#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

usage() {
  cat >&2 <<'USAGE'
Usage: ALTER_DOMAINS=www.example.com ./scripts/create-proxy.sh <domain> <upstream>

Examples:
  ./scripts/create-proxy.sh app.example.com http://127.0.0.1:3000
USAGE
}

MAIN_DOMAIN="${MAIN_DOMAIN:-}"
UPSTREAM="${UPSTREAM:-}"
ALTER_DOMAINS="${ALTER_DOMAINS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$MAIN_DOMAIN" ]]; then
        MAIN_DOMAIN="$1"
      elif [[ -z "$UPSTREAM" ]]; then
        UPSTREAM="$1"
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$MAIN_DOMAIN" && -n "$UPSTREAM" ]] || { usage; exit 1; }
[[ "$MAIN_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain: $MAIN_DOMAIN" >&2; exit 1; }

SERVER_NAMES="$MAIN_DOMAIN $(printf '%s' "$ALTER_DOMAINS" | tr ',' ' ')"
CONF_PATH="nginx/conf.d/$MAIN_DOMAIN.conf"
TEMPLATE="nginx/templates/proxy.conf.template"

export MAIN_DOMAIN SERVER_NAMES UPSTREAM
python3 - "$TEMPLATE" "$CONF_PATH" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for key in ("MAIN_DOMAIN", "SERVER_NAMES", "UPSTREAM"):
    text = text.replace(f"__{key}__", os.environ[key])
open(dst, "w").write(text)
PY

echo "Created HTTP+HTTPS proxy vhost with default self-signed cert: $CONF_PATH"
echo "To enable real NGINX ACME later, edit $CONF_PATH and switch the marked TLS block."

if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx nginx; then
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  echo "Reloaded nginx"
else
  echo "nginx container is not running; start it then run: docker compose exec nginx nginx -s reload"
fi
