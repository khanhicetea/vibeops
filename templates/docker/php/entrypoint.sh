#!/bin/bash
set -euo pipefail

ROLE="${BENTO_ROLE:-fpm}"

# Ensure runtime dirs exist (volatile)
mkdir -p /run/php-fpm /var/log/supervisor /tmp

# Include Bento-managed pools if present
if [ -d /usr/local/etc/php-fpm.d/bento ]; then
  # pools are mounted read-only from generated state
  true
fi

if [ "$ROLE" = "runner" ]; then
  exec /usr/local/bin/bento-runner-entrypoint "$@"
fi

if [ "$#" -eq 0 ]; then
  set -- php-fpm -F
fi

exec "$@"
