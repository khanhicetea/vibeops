#!/bin/sh
# Container-local deploy drain entrypoint for supercronic.
set -eu
umask 077
APP="${1:-}"
SOCKET="${2:-}"
if [ -z "$APP" ]; then
  echo "usage: deploy-drain.sh <app> [fpm-socket]" >&2
  exit 2
fi
if ! command -v php >/dev/null 2>&1; then
  echo "deploy drain unavailable: php CLI is missing" >&2
  exit 127
fi
HELPER=/opt/bento/helpers/deploy-drain.php
if [ ! -r "$HELPER" ]; then
  echo "deploy drain unavailable: $HELPER is missing" >&2
  exit 127
fi
if [ -n "$SOCKET" ]; then
  exec php "$HELPER" "$APP" "$SOCKET"
fi
exec php "$HELPER" "$APP"
