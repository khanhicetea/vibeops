#!/bin/sh
# Managed deploy drain entrypoint for supercronic (runs as app via bento runner helpers).
# Actual drain authority lives in the control plane; this script is a container-side bridge.
set -eu
APP="${1:-}"
if [ -z "$APP" ]; then
  echo "usage: deploy-drain.sh <app>" >&2
  exit 2
fi
# Prefer invoking bento if present on host-mounted path; otherwise no-op with note.
if command -v bento >/dev/null 2>&1; then
  exec bento deploy drain "$APP"
fi
echo "bento deploy drain not available in runner image for $APP" >&2
exit 0
