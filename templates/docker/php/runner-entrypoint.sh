#!/bin/sh
set -eu

# /init from s6-overlay is PID 1. This command runs as its supervised CMD and
# owns a dynamic nested scan tree for generated app schedulers and workers.
mkdir -p /var/log/bento /run/bento /run/bento-s6 /etc/bento/cron /etc/bento/services

/usr/local/bin/bento-s6-reconcile --initial
exec /command/s6-svscan /run/bento-s6/services
