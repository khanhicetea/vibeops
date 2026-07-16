#!/bin/sh
set -eu
CERT_DIR="${BENTO_CERT_DIR:-/etc/nginx/certs}"
CRT="$CERT_DIR/boot.crt"
KEY="$CERT_DIR/boot.key"

if [ -f "$CRT" ] && [ -f "$KEY" ]; then
  exit 0
fi

mkdir -p "$CERT_DIR"
# Self-signed boot certificate so HTTPS vhosts can start before ACME/external certs exist.
openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$KEY" \
  -out "$CRT" \
  -days 825 \
  -subj "/CN=bento-boot/O=Bento/C=US" \
  >/dev/null 2>&1 || true

chmod 600 "$KEY" 2>/dev/null || true
chmod 644 "$CRT" 2>/dev/null || true
