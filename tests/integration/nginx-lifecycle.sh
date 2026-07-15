#!/usr/bin/env bash
set -euo pipefail

# Opt-in integration check for a running, rebuilt Bento Nginx container.
DC=${DC:-./dc}

$DC exec -T nginx nginx -t
[ "$($DC exec -T nginx cat /proc/1/comm)" = nginx ] || { echo "nginx is not PID 1" >&2; exit 1; }
before=$($DC exec -T nginx sh -c 'cat /var/run/nginx.pid')
$DC exec -T nginx nginx -s reload
sleep 1
after=$($DC exec -T nginx sh -c 'cat /var/run/nginx.pid')
[ "$before" = "$after" ] || { echo "nginx master PID changed during reload" >&2; exit 1; }

$DC exec -T nginx nginx -s reopen
./manage.py maintenance
curl --fail --silent --show-error http://127.0.0.1:8080/healthz >/dev/null

echo "nginx config test, reload, reopen, maintenance, and loopback report endpoint passed"
