# VibeOps architecture and file layout

This repository separates source config from mutable runtime data. The primary isolation unit is an app slug, which is also the Linux user, PHP-FPM pool, and MySQL user.

```text
compose.yml                 # service topology
manage.py                   # management CLI

docker/                     # Docker build contexts and image helper binaries
  php/
  redis/

config/                     # committed stack configuration and templates
  nginx/                    # host-network edge config
  php/                      # PHP common config, versioned pools/app users, templates
  mysql/                    # shared + versioned MySQL config and SQL templates

runtime/                    # mutable/generated/live data
  home/                     # mounted as /home into nginx/php; app homes live at <app>/www
  run/php-fpm/php84|php85/  # PHP-FPM Unix sockets
  nginx/vhosts/             # generated vhosts; PHP apps use app-<app>.conf
  cron/php84|php85/         # generated cron state for supercronic
  logs/                     # nginx/php logs
  backups/mysql57|mysql84|mysql97/ # versioned database backups
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

## App model

`stack.json` schema 2 stores PHP apps under `apps` and a stack-wide `domains` index for collision checks and TLS lookup. Each app records its selected MySQL service (`mysql_service`, plus host/port/user metadata); the default comes from `.env` `DEFAULT_MYSQL_SERVICE` unless `--mysql-service` is passed when creating the app/database. A PHP app vhost is named `runtime/nginx/vhosts/app-<app_name>.conf`; proxy vhosts remain domain-keyed.

Filesystem layout for an app:

```text
runtime/home/<app_name>/
  www/
  logs/
  .credentials/
  .ssh/
  .composer/
```

All domains on an app share the same code tree under `/home/<app_name>/www` and `/run/php-fpm/<php_service>/<app_name>.sock`. The app's `public_dir` metadata selects the Nginx document root inside that tree: empty string means `/home/<app_name>/www` (WordPress/default), while `public` means `/home/<app_name>/www/public` (Laravel). Separate codebases should be separate apps.
