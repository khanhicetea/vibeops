# VibeOps architecture and file layout

This repository separates source config from mutable runtime data while keeping the Docker runtime model unchanged.

```text
compose.yml                 # service topology
manage.py                   # management CLI

docker/                     # Docker build contexts and image helper binaries
  php/
  redis/

config/                     # committed stack configuration and templates
  nginx/                    # host-network edge config
  php/                      # PHP common config, versioned pools/users, templates
  mysql/                    # MySQL config and SQL templates

runtime/                    # mutable/generated/live data
  home/                     # mounted as /home into nginx/php
  run/php-fpm/php84|php85/  # PHP-FPM Unix sockets
  nginx/vhosts/             # generated vhosts
  cron/php84|php85/         # generated cron state for supercronic
  logs/                     # nginx/php logs
  backups/                  # database backups
  certs/                    # external certificate files
  nginx-acme-state/         # NGINX ACME account/cert/key state
```

## Cron layout

Cron is version-scoped to match the Docker services:

```text
runtime/cron/php84/jobs/*.cron
runtime/cron/php84/.supercronic.cron
runtime/cron/php85/jobs/*.cron
runtime/cron/php85/.supercronic.cron
```

`manage.py cron create` writes one job file under `jobs/`, then rebuilds `.supercronic.cron`. The cron container mounts `runtime/cron/phpXX` at `/usr/local/etc/php/cron.d` and runs Supercronic against `.supercronic.cron`.
