#!/bin/bash
set -euo pipefail

ROLE="${BENTO_ROLE:-fpm}"

# Ensure runtime dirs exist (volatile)
mkdir -p /run/php-fpm /var/log/supervisor /tmp

# php-fpm only auto-includes php-fpm.d/*.conf (not subdirectories).
# Ensure Bento pool directory is included even on older images that lack
# the baked-in include from zz-docker.conf.
#
# When compose bind-mounts zz-bento-pools.conf read-only, the file already
# exists and must not be rewritten (would crash with "Read-only file system").
include_file=/usr/local/etc/php-fpm.d/zz-bento-pools.conf
if [ -d /usr/local/etc/php-fpm.d/bento ]; then
  if [ ! -e "$include_file" ]; then
    cat > "$include_file" <<'EOF'
; Auto-included Bento per-app pools (bind-mounted under php-fpm.d/bento/)
include=/usr/local/etc/php-fpm.d/bento/*.conf
EOF
  fi
fi

if [ "$ROLE" = "runner" ]; then
  exec /usr/local/bin/bento-runner-entrypoint "$@"
fi

if [ "$#" -eq 0 ]; then
  set -- php-fpm -F
fi

exec "$@"
