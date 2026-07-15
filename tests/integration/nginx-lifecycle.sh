#!/usr/bin/env bash
set -euo pipefail

# Opt-in integration check for a running, rebuilt Bento Nginx container.
DC=${DC:-./dc}

$DC exec -T nginx nginx -t
before=$($DC exec -T nginx sh -c 'cat /var/run/nginx.pid')
$DC exec -T nginx nginx -s reload
sleep 1
after=$($DC exec -T nginx sh -c 'cat /var/run/nginx.pid')
[ "$before" = "$after" ] || { echo "nginx master PID changed during reload" >&2; exit 1; }

$DC exec -T nginx nginx -s reopen
$DC exec -T nginx supercronic -no-reap -test /etc/bento/nginx-maintenance.cron
$DC exec -T nginx bento-nginx-maintenance rotate all false
curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8080/goaccess/ >/dev/null

echo "nginx config test, reload, reopen, maintenance, and loopback report endpoint passed"
