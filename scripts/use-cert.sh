#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat >&2 <<'USAGE'
Usage: ./scripts/use-cert.sh <domain> [--cert /container/fullchain.pem] [--key /container/privkey.pem]

Switch an existing generated vhost from the default self-signed cert/ACME toggle block
to explicit certificate files.

Defaults expect files mounted from ./certs:
  /etc/letsencrypt/live/<domain>/fullchain.pem
  /etc/letsencrypt/live/<domain>/privkey.pem

Examples:
  ./scripts/use-cert.sh example.com
  ./scripts/use-cert.sh example.com --cert /etc/letsencrypt/live/example.com/fullchain.pem --key /etc/letsencrypt/live/example.com/privkey.pem
USAGE
}

MAIN_DOMAIN=""
CERT_PATH=""
CERT_KEY_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cert|--fullchain)
      CERT_PATH="${2:-}"
      shift 2
      ;;
    --key|--privkey)
      CERT_KEY_PATH="${2:-}"
      shift 2
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

CERT_PATH="${CERT_PATH:-/etc/letsencrypt/live/$MAIN_DOMAIN/fullchain.pem}"
CERT_KEY_PATH="${CERT_KEY_PATH:-/etc/letsencrypt/live/$MAIN_DOMAIN/privkey.pem}"

export CERT_PATH CERT_KEY_PATH
python3 - "$CONF_PATH" <<'PY'
import os, re, sys
path = sys.argv[1]
text = open(path).read()
replacement = """# BEGIN TLS_CERTIFICATE
    ssl_certificate __CERT_PATH__;
    ssl_certificate_key __CERT_KEY_PATH__;
    # END TLS_CERTIFICATE"""
replacement = replacement.replace("__CERT_PATH__", os.environ["CERT_PATH"])
replacement = replacement.replace("__CERT_KEY_PATH__", os.environ["CERT_KEY_PATH"])
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

if [[ "$CERT_PATH" == /etc/letsencrypt/* ]]; then
  host_cert="certs/${CERT_PATH#/etc/letsencrypt/}"
  [[ -f "$host_cert" ]] || echo "Warning: expected host file docker-stack/$host_cert was not found." >&2
fi
if [[ "$CERT_KEY_PATH" == /etc/letsencrypt/* ]]; then
  host_key="certs/${CERT_KEY_PATH#/etc/letsencrypt/}"
  [[ -f "$host_key" ]] || echo "Warning: expected host file docker-stack/$host_key was not found." >&2
fi

echo "Switched $MAIN_DOMAIN to certificate files:"
echo "  cert: $CERT_PATH"
echo "  key:  $CERT_KEY_PATH"

if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx nginx; then
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  echo "Reloaded nginx"
else
  echo "nginx container is not running; start it then run: docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload"
fi
