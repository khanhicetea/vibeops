#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat >&2 <<'USAGE'
Usage: ./scripts/acme.sh <domain> [--off|--self-signed] [--no-reload]

Enable the official NGINX ACME module for a generated vhost by commenting the
self-signed certificate lines and uncommenting the ACME certificate lines.

Examples:
  ./scripts/acme.sh example.com
  ./scripts/acme.sh example.com --off
USAGE
}

MAIN_DOMAIN=""
MODE="on"
RELOAD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --on|--enable)
      MODE="on"
      shift
      ;;
    --off|--disable|--self-signed)
      MODE="off"
      shift
      ;;
    --no-reload)
      RELOAD=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$MAIN_DOMAIN" ]]; then
        MAIN_DOMAIN="$1"
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$MAIN_DOMAIN" ]] || { usage; exit 1; }
[[ "$MAIN_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain: $MAIN_DOMAIN" >&2; exit 1; }

CONF_PATH="nginx/conf.d/$MAIN_DOMAIN.conf"
[[ -f "$CONF_PATH" ]] || { echo "Missing vhost: docker-stack/$CONF_PATH" >&2; exit 1; }

export MODE
python3 - "$CONF_PATH" <<'PY'
import os
import re
import sys

path = sys.argv[1]
mode = os.environ["MODE"]
text = open(path).read()

if mode == "on":
    replacement = """# BEGIN TLS_CERTIFICATE
    # ssl_certificate /etc/nginx/self-signed/default.crt;
    # ssl_certificate_key /etc/nginx/self-signed/default.key;

    acme_certificate letsencrypt;
    ssl_certificate $acme_certificate;
    ssl_certificate_key $acme_certificate_key;
    # END TLS_CERTIFICATE"""
else:
    replacement = """# BEGIN TLS_CERTIFICATE
    ssl_certificate /etc/nginx/self-signed/default.crt;
    ssl_certificate_key /etc/nginx/self-signed/default.key;

    # acme_certificate letsencrypt;
    # ssl_certificate $acme_certificate;
    # ssl_certificate_key $acme_certificate_key;
    # END TLS_CERTIFICATE"""

text2, count = re.subn(
    r"# BEGIN TLS_CERTIFICATE\n.*?\n\s*# END TLS_CERTIFICATE",
    replacement,
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f"Could not find marked TLS certificate block in {path}")

open(path, "w").write(text2)
PY

if [[ "$MODE" == "on" ]]; then
  echo "Enabled NGINX ACME for $MAIN_DOMAIN in docker-stack/$CONF_PATH"
else
  echo "Switched $MAIN_DOMAIN back to the default self-signed certificate in docker-stack/$CONF_PATH"
fi

if [[ "$RELOAD" == "1" ]]; then
  if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx nginx; then
    docker compose exec -T nginx nginx -t
    docker compose exec -T nginx nginx -s reload
    echo "Reloaded nginx"
  else
    echo "nginx container is not running; start it then run: docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload"
  fi
fi
