# VibeOps architecture and file layout

This repository separates upstream source, local desired state, disposable generated config, and live runtime data. The primary isolation unit is an app slug, which is also the Linux user, PHP-FPM pool, and MySQL user.

```text
compose.yml                 # upstream-owned service topology
compose.override.yml        # optional ignored local Docker Compose overrides
manage.py                   # thin CLI entrypoint into vibeops.cli
vibeops/                    # management CLI package

docker/                     # Docker build contexts and image helper binaries
  php/
  redis/

config/                     # committed stack configuration and templates
  nginx/                    # host-network edge config, snippets, templates
  php/                      # PHP common config and templates
  mysql/                    # shared + versioned MySQL config and SQL templates

runtime/                    # local state/generated/live data
  state/stack.json          # source of truth for apps/domains/proxies/crons
  generated/                # disposable rendered config; regenerate with ./manage.py render
    nginx/vhosts/           # generated vhosts; PHP apps use app-<app>.conf
    php/versions/*/         # generated PHP-FPM users and pools
    cron/php84|php85/       # generated cron state for supercronic
  custom/                   # user-owned customization hooks/compose adjuncts
  home/                     # mounted as /home into nginx/php; app homes live at <app>/www
  run/php-fpm/php84|php85/  # PHP-FPM Unix sockets
  logs/                     # nginx/php logs
  backups/mysql57|mysql84|mysql97/ # versioned database backups
  certs/                    # external certificate files
  nginx-acme-state/         # NGINX ACME account/cert/key state
```

## Render/apply model

`runtime/state/stack.json` is the source of truth for apps, domains, proxy vhosts, TLS mode, and cron jobs. Files under `runtime/generated/` are disposable artifacts and should not be edited directly.

```bash
./manage.py render          # regenerate runtime/generated from state
./manage.py apply           # render, then validate/reload running services
./manage.py state migrate   # move/upgrade legacy ./stack.json
```

Users should customize Docker Compose with ignored override files instead of editing `compose.yml`:

```text
compose.override.yml        # auto-loaded by docker compose
compose.local.yml           # loaded by ./manage.py compose
compose.d/*.yml             # loaded by ./manage.py compose
```

Use `./manage.py compose ...` when you want all local fragments included. See `docs/customization.md` for examples, edge cases, and do/don't guidance.

## Cron layout

Cron is version-scoped to match the Docker services:

```text
runtime/generated/cron/php84/jobs/*.cron
runtime/generated/cron/php84/.supercronic.cron
runtime/generated/cron/php85/jobs/*.cron
runtime/generated/cron/php85/.supercronic.cron
```

`manage.py cron create` writes one job file under `jobs/`, then rebuilds `.supercronic.cron`. The cron container mounts `runtime/generated/cron/phpXX` at `/usr/local/etc/php/cron.d` and runs Supercronic against `.supercronic.cron`.

## App model

`runtime/state/stack.json` schema 3 stores PHP apps under `apps` and a stack-wide `domains` index for collision checks and TLS lookup. Each app records its selected MySQL service (`mysql_service`, plus host/port/user metadata); the default comes from `.env` `DEFAULT_MYSQL_SERVICE` unless `--mysql-service` is passed when creating the app/database. A PHP app vhost is named `runtime/generated/nginx/vhosts/app-<app_name>.conf`; proxy vhosts remain domain-keyed.

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
