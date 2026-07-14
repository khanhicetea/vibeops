#!/usr/bin/env bash
set -Eeuo pipefail

# biarms/mysql's legacy entrypoint fixes ownership of the data directory before
# dropping privileges, but not a bind-mounted log directory. Prepare it while
# still root, then delegate all database initialization to the image entrypoint.
if [[ "$(id -u)" == 0 ]]; then
    mkdir -p /var/log/mysql
    chown -R mysql:mysql /var/log/mysql
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
