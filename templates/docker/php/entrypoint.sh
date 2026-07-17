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

# Ephemeral app CLI: start as root, install a real passwd/group name for the
# app UID/GID (avoids bash "I have no name!"), then drop via setpriv — same
# privilege model as runner cron/workers. Do not use docker -u for CLI.
if [ "$ROLE" = "cli" ]; then
  app_name="${BENTO_APP:-}"
  app_uid="${BENTO_UID:-}"
  app_gid="${BENTO_GID:-}"
  app_home="${HOME:-}"

  if [ -z "$app_name" ] || [ -z "$app_uid" ] || [ -z "$app_gid" ]; then
    echo "bento-php-entrypoint: CLI role requires BENTO_APP, BENTO_UID, BENTO_GID" >&2
    exit 64
  fi
  if [ -z "$app_home" ]; then
    app_home="/home/${app_name}"
  fi

  # Group for app GID (prefer app slug when that name is free).
  if ! getent group "$app_gid" >/dev/null 2>&1; then
    if getent group "$app_name" >/dev/null 2>&1; then
      echo "bento${app_gid}:x:${app_gid}:" >> /etc/group
    else
      echo "${app_name}:x:${app_gid}:" >> /etc/group
    fi
  fi

  # Passwd entry for app UID so shells resolve a real username.
  if ! getent passwd "$app_uid" >/dev/null 2>&1; then
    if getent passwd "$app_name" >/dev/null 2>&1; then
      uname="bento${app_uid}"
    else
      uname="$app_name"
    fi
    echo "${uname}:x:${app_uid}:${app_gid}:${app_name}:${app_home}:/bin/bash" >> /etc/passwd
  fi

  resolved="$(getent passwd "$app_uid" | cut -d: -f1 || true)"
  export HOME="$app_home"
  export USER="${resolved:-$app_name}"
  export LOGNAME="$USER"
  export SHELL=/bin/bash

  if [ "$#" -eq 0 ]; then
    set -- bash
  fi

  exec setpriv --reuid="$app_uid" --regid="$app_gid" --clear-groups -- "$@"
fi

if [ "$#" -eq 0 ]; then
  set -- php-fpm -F
fi

exec "$@"
