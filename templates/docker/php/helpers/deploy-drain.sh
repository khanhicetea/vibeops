#!/bin/sh
set -eu
APP="${1:-}"
if [ -z "$APP" ]; then
  echo "usage: deploy-drain.sh <app>" >&2
  exit 2
fi
if command -v bento >/dev/null 2>&1; then
  exec bento deploy drain "$APP"
fi
echo "bento deploy drain not available in runner for $APP" >&2
exit 0
