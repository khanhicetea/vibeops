#!/bin/bash
set -euo pipefail

mkdir -p /var/log/supervisor /run/bento /etc/bento/cron

CONF="${BENTO_SUPERVISORD_CONF:-/etc/bento/supervisord.conf}"
if [ ! -f "$CONF" ]; then
  cat > /tmp/supervisord-fallback.conf <<'EOF'
[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
EOF
  CONF=/tmp/supervisord-fallback.conf
fi

exec supervisord -c "$CONF"
