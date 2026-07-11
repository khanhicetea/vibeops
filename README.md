# VibeOps — vibe-coding ops stack

VibeOps is a Docker-based LEMP operations stack for vibe-coding workflows, with host-network Nginx, Unix-socket PHP-FPM, multi PHP versions, MySQL, Redis, cron, and ACME-ready TLS.

It is optimized for production performance and DX around isolated apps. The primary deployable unit is an app slug:

```text
/home/<app_name>/www
```

In this stack that maps to:

```text
vibeops/runtime/home/<app_name>/www
```

## Architecture

- **Nginx** runs with `network_mode: host`
  - no Docker TCP/UDP port publishing
  - no bridge NAT for public HTTP/HTTPS traffic
  - binds directly to host `:80` / `:443` TCP and `:443` UDP for HTTP/3
- **Multiple PHP-FPM versions** run as separate Debian Trixie-based containers:
  - `php84` from `php:8.4-fpm-trixie`
  - `php85` from `php:8.5-fpm-trixie`
  - OPcache is installed only when `php -m` shows it is missing, so PHP 8.5 can use its built-in Zend OPcache without reinstalling it.
- **PHP-FPM exposes per-app Unix sockets** in versioned shared dirs:
  - host path: `vibeops/runtime/run/php-fpm/php84/<app_name>.sock`
  - nginx path: `/run/php-fpm/php84/<app_name>.sock`
  - PHP container path: `/run/php-fpm/<app_name>.sock`
- **Each app is a Linux user / PHP-FPM pool / MySQL user** inside PHP containers:
  - app home: `/home/<app_name>`
  - document root: `/home/<app_name>/www`
  - logs: `/home/<app_name>/logs`
- **PHP runtime is split by role** while sharing the same PHP image/version:
  - `php84` / `php85` run PHP-FPM only and expose sockets
  - `php84-cron` / `php85-cron` run supercronic only
  - `php84-cli` / `php85-cli` are ephemeral deploy/shell services
  - deploy commands, Composer, cron, and PHP-FPM still use the same PHP binary/extensions
- **PHP connects to MySQL/Redis** over the Compose backend network:
  - MySQL hosts are versioned services: `mysql57:3306`, `mysql84:3306`, `mysql97:3306`
  - `DEFAULT_MYSQL_SERVICE` defaults generated apps to `mysql84`
  - Redis host: `redis:6379`
- **Nginx reads app files from `/home` read-only** and talks to PHP by Unix sockets.
- **The official NGINX ACME module is enabled** with HTTP-01.
  - Generated vhosts always include both HTTP and HTTPS.
  - HTTPS starts with a default self-signed cert so Nginx can boot before DNS/ACME is ready.
  - When ready, edit the marked TLS block in the vhost to switch from self-signed to ACME.
  - ACME state is persisted in `runtime/nginx-acme-state/`.

## Layout

```text
compose.yml
.env.example
manage.py                     # create apps/domains/crons and run app commands
docs/architecture.md          # current file-layout/architecture notes

docker/                       # Docker build contexts and image helper binaries
config/                       # committed stack config and templates
  nginx/                      # Nginx global config, snippets, templates, self-signed cert
  php/                        # PHP common config and templates
  mysql/                      # shared + versioned MySQL config and SQL templates
runtime/                      # mutable/generated/live data
  state/stack.json            # local source of truth for apps/domains/proxies/crons
  generated/                  # disposable rendered config; regenerate with ./manage.py render
    nginx/vhosts/             # generated vhosts
    php/versions/             # generated PHP-FPM users/pools
    cron/php84/jobs/          # generated PHP 8.4 cron jobs
    cron/php85/jobs/          # generated PHP 8.5 cron jobs
  custom/                     # user-owned customization hooks
  home/                       # /home bind mount for app homes
  run/php-fpm/php84/          # PHP 8.4 sockets
  run/php-fpm/php85/          # PHP 8.5 sockets
  nginx-acme-state/           # NGINX ACME account/cert/private-key state
  logs/                       # nginx/php/mysql logs
    mysql84/                  # mysqld error + slow query logs (per MySQL service)
  certs/                      # externally managed cert files
  backups/                    # logical dumps (mysql57/mysql84/mysql97)
  secrets/mysql/              # generated mode-600 MySQL admin option files
```

## Quick start

```bash
cd vibeops
cp .env.example .env
# edit MYSQL_ROOT_PASSWORD

./manage.py render

docker compose build php84 php85 php84-cron php85-cron
# mysql84 is the default MySQL service.
docker compose up -d mysql84 redis php84 php85 php84-cron php85-cron nginx
# Optional extra majors:
# docker compose --profile mysql57 --profile mysql97 up -d mysql57 mysql97
```

## Interactive DX

For guided operations, run the no-dependency Python wizard:

```bash
./manage.py
# or explicitly:
./manage.py wizard
./manage.py tui
```

The wizard can create apps, app domains and databases, proxy vhosts, TLS/ACME config, cron jobs, open app shells, and show stack status. Its domain and cron managers present numbered listings for selecting a main domain or deleting an alias/cron, then refresh the listing after changes. It previews the plan before applying changes and prints equivalent CLI commands for common flows.

For a quick dashboard without entering the wizard:

```bash
./manage.py status
./manage.py status --check-nginx
```

Keep `compose.yml` upstream-owned. Put local Docker Compose customization in ignored `compose.override.yml`, `compose.local.yml`, or `compose.d/*.yml`; use `./manage.py compose ...` to include all local fragments. See `docs/customization.md` for examples and edge cases.

## Create an app

Default PHP version comes from `.env` `DEFAULT_PHP_VERSION`. An app slug is stack-wide unique and becomes the Linux user, PHP-FPM pool, and MySQL user.

```bash
./manage.py app create shop shop.example.com app --php 8.5 --alias www.shop.example.com
# Laravel/Symfony/front-controller apps usually serve from /home/<app>/www/public.
# Non-empty --public-dir defaults to PHP front-controller mode: only /index.php executes.
./manage.py app create laravel laravel.example.com app --public-dir public
# WordPress/default/legacy apps serve directly from /home/<app>/www and allow direct PHP scripts:
./manage.py app create wp wp.example.com app
# Force legacy PHP routing if a public-dir app needs multiple direct PHP endpoints:
./manage.py app create oldapp old.example.com app --public-dir public --php-entrypoint legacy
# choose a MySQL major for the optional DB creation:
./manage.py app create legacy legacy.example.com app --mysql-service mysql57
```

This creates, for example:

```text
runtime/home/shop/www/
runtime/home/shop/logs/
runtime/generated/php/versions/8.5/users.d/shop.env
runtime/generated/php/versions/8.5/pool.d/shop.conf
runtime/generated/nginx/vhosts/app-shop.conf
runtime/run/php-fpm/php85/shop.sock   # appears after php85 reload/start
```

The generated Nginx vhost uses the selected PHP socket plus app metadata:

- `public_dir`: document root subdirectory inside `/home/<app>/www`; empty means app root.
- `php_entrypoint`: `front-controller` only executes `/index.php` and returns 404 for other `.php` paths; `legacy` allows existing `.php` scripts. `auto` chooses `front-controller` when `public_dir` is non-empty, otherwise `legacy`.

```nginx
# default / WordPress-style
root /home/shop/www;

# Laravel-style when --public-dir public
root /home/laravel/www/public;

fastcgi_pass unix:/run/php-fpm/php85/shop.sock;

# front-controller mode hardens single-entry apps:
location = /index.php { ... fastcgi_pass ... }
location ~ \.php$ { return 404; }
```

The optional DB suffix, `app`, creates `shop_app` on the app's `mysql_service` (default: `.env` `DEFAULT_MYSQL_SERVICE`, usually `mysql84`, unless `--mysql-service` is passed). The app's MySQL user is `shop` on that service and has prefix grants for `shop_*` databases. MySQL grants escape wildcard characters in app names before granting access, so valid app names containing `_` do not broaden privileges.

Credentials are written to `runtime/home/<app>/.credentials/<mysql_service>.env` (mode 600). That file contains both `MYSQL_*` and Laravel-style `DB_*` keys. The password is not printed to stdout; open the credentials file when you need it. `DB_DATABASE` / full name is `{app}_{db_suffix}` when you pass a database suffix to `app create` or `db create`.

PHP app connection values:

```text
DB_HOST=mysql84
DB_PORT=3306
DB_DATABASE=shop_app
DB_USERNAME=shop
REDIS_HOST=redis
REDIS_PORT=6379
```

## App domains

An app has exactly one main domain plus optional alias domains. All domains on an app share the same code tree, PHP-FPM pool, and databases. A domain may belong to only one app or proxy vhost.

```bash
./manage.py app domain add shop alt.shop.example.com
./manage.py app domain set-main shop www.shop.example.com
./manage.py app domain remove shop alt.shop.example.com
./manage.py app domain list shop
./manage.py app domain set-main shop --number 2
./manage.py app domain remove shop --number 3
./manage.py app show shop
```

Use a separate app slug for a separate codebase; the old multi-site-under-one-user model is deprecated.

## Deploy app code and run Composer

Run app commands in an ephemeral matching PHP CLI container as the same Linux user used by PHP-FPM:

```bash
./manage.py shell
# or explicitly:
./manage.py shell shop --php 8.5
./manage.py exec shop --php 8.5 -- git clone git@github.com:org/project.git .
./manage.py exec shop --php 8.5 -- composer install
./manage.py exec shop --php 8.5 -- php artisan migrate
```

SSH deploy keys can live in `runtime/home/shop/.ssh/` with normal SSH permissions.

## Cron jobs

Cron runs in separate `php84-cron` / `php85-cron` containers. Create cron jobs per app and PHP version:

```bash
./manage.py cron create shop schedule '* * * * *' 'php artisan schedule:run' --php 8.5
./manage.py cron list
./manage.py cron remove shop schedule  # or: ./manage.py cron remove --number 1
```

This writes:

```text
runtime/generated/cron/php85/jobs/shop-schedule.cron
runtime/generated/cron/php85/.supercronic.cron
```

The job runs in the `php85-cron` container as the private `shop:shop` identity, from `/home/shop/www`, with the PHP 8.5 binary/extensions and the same container environment as PHP-FPM. The root scheduler uses the narrow `php-cron-as` helper only to validate inputs and drop privileges; it never creates, chowns, or repairs app paths. `manage.py` atomically merges `jobs/*.cron` into `.supercronic.cron`, validates a running scheduler with `supercronic -test`, and reloads PID 1 with `SIGUSR2`.

Every PHP version receives a valid crontab during `render`. It always contains a daily maintenance job, so Supercronic remains running even with no app jobs and the first real job never requires a container restart. Do not scale a cron service to multiple replicas, or jobs will run more than once.

Cron supports bounded workdirs, IANA timezones, timeouts, app-scoped shared locks, and optional private file output:

```bash
./manage.py cron create shop report '0 2 * * *' 'php artisan report:send' \
  --php 8.5 --timezone Asia/Ho_Chi_Minh --timeout 1800 --lock reports
./manage.py cron create shop import '*/5 * * * *' 'php artisan import:run' \
  --php 8.5 --output file
```

Default `--output docker` keeps application output with structured Supercronic lifecycle/exit logs. Docker's `local` logging driver rotates and compresses service stdout/stderr (`20m` × 5 files). `--output file` writes as the app user to `/home/<app>/logs/cron-<php-cron-service>-<job>.log`. The always-present daily logrotate job retains 14 rotations as dated archives such as `.log-2026-07-11` (with older archives compressed), without changing the live file's UID/GID. The same policy covers that version's PHP-FPM error and slow logs. Scheduler health and Prometheus metrics are available inside the backend network at `http://php85-cron:9746/health` and `/metrics` (similarly for PHP 8.4).

## Change an app's PHP version

Re-run `manage.py app create` with another `--php` version. It regenerates app identity and the Nginx vhost:

```bash
./manage.py app create shop shop.example.com --php 8.4
```

Deprecated compatibility commands remain for now: `user create` creates only the app identity, and `site create` prints guidance or maps to `app create` only for unambiguous new apps.

## TLS certificates

The NGINX ACME module is loaded and configured globally:

- issuer: Let's Encrypt production directory
- challenge: HTTP-01
- persisted state: `runtime/nginx-acme-state/` mounted at `/var/cache/nginx/acme-letsencrypt`

Generated vhosts start with this active self-signed block:

```nginx
ssl_certificate /etc/nginx/self-signed/default.crt;
ssl_certificate_key /etc/nginx/self-signed/default.key;

# acme_certificate letsencrypt;
# ssl_certificate $acme_certificate;
# ssl_certificate_key $acme_certificate_key;
```

When DNS is ready, enable real ACME and reload Nginx automatically:

```bash
./manage.py tls acme example.com
```

To switch back to the boot self-signed cert:

```bash
./manage.py tls acme example.com --off
```

`runtime/nginx-acme-state/` contains private keys after first issuance; keep it backed up and private. To change issuer settings, edit `config/nginx/global/00-nginx.conf`.

If you need to use externally managed certificate files instead, place them under `runtime/certs/` using the usual Let's Encrypt layout:

```text
runtime/certs/live/example.com/fullchain.pem
runtime/certs/live/example.com/privkey.pem
```

Then switch an existing generated vhost to file-based certs:

```bash
./manage.py tls cert example.com
```

Or pass explicit paths as seen inside the Nginx container:

```bash
./manage.py tls cert example.com \
  --cert /etc/letsencrypt/live/example.com/fullchain.pem \
  --key /etc/letsencrypt/live/example.com/privkey.pem
```

## Add another PHP version

Copy an existing PHP service in `compose.yml` and change both the service suffix (`phpXX`) and PHP version directory (`8.x`) consistently:

```yaml
  phpXX:
    <<: *php-common
    build:
      context: ./docker/php
      args:
        PHP_VERSION: 8.x
        TZ: ${TZ:-Asia/Ho_Chi_Minh}
    volumes:
      - ./runtime/home:/home
      - ./runtime/run/php-fpm/phpXX:/run/php-fpm
      - ./runtime/logs/php/phpXX:/var/log/php
      - ./config/php/common/conf.d/90-custom.ini:/usr/local/etc/php/conf.d/90-custom.ini:ro
      - ./runtime/generated/php/versions/8.x/pool.d:/usr/local/etc/php-fpm.d/pools:ro
      - ./runtime/generated/php/versions/8.x/users.d:/usr/local/etc/php/users.d:ro
      - ./runtime/generated/cron/phpXX:/usr/local/etc/php/cron.d:ro
```

Then:

```bash
mkdir -p runtime/generated/php/versions/8.x/{pool.d,users.d} runtime/generated/cron/phpXX/jobs runtime/run/php-fpm/phpXX runtime/logs/php/phpXX
docker compose build phpXX
docker compose up -d phpXX
./manage.py app create myapp example.com --php 8.x
```

## Identity and permission management

Each app has a private Linux user and group with the same numeric UID/GID. PHP-FPM workers run as that private group; `nginxsock` (normally GID `101`) is only the shared **socket group** so Nginx can open FPM sockets and read public files. App users are not members of `nginxsock`.

Container startup and `apply` synchronize identities but never recursively traverse app homes. Diagnose an identity issue with:

```bash
./manage.py identity sync shop
./manage.py identity sync --all
```

Filesystem repair is explicit. Check first, use `--dry-run` before a large repair, and use `--json` for automation:

```bash
./manage.py permissions check shop
./manage.py permissions check --all
./manage.py permissions fix shop
./manage.py permissions fix shop --recursive --dry-run
./manage.py permissions fix shop --recursive
./manage.py permissions check shop --json
```

A recursive repair can scan a large tree. It keeps private paths private and reapplies Nginx-readable group policy only below the selected document root. App creation performs this repair once while the tree is new. `manage.py exec` and `shell` run as the app's private UID/GID with `umask 0027`; setgid public directories make newly created public files inherit the Nginx-readable group. Use an explicit recursive repair after importing or changing an existing tree.

## MySQL databases and backups

Logical dumps go under `runtime/backups/<mysql_service>/` (mounted at `/backups` in each MySQL container). Prefer these over ad-hoc `docker compose exec` with root passwords on the host process list.

`./manage.py render` generates ignored, mode-600 root client option files under `runtime/secrets/mysql/` from the long random root password in `.env`. Each MySQL service mounts only its own file read-only at `/run/secrets/vibeops-root.cnf`; health checks and `manage.py` administrative commands use that file, so passwords are not passed in client command arguments. Re-run `./manage.py render` and recreate the affected MySQL container after changing a root password. Keep `.env` as the recovery source and never commit or copy these option files into images.

```bash
./manage.py db list
./manage.py db list --app shop
./manage.py db create shop app
./manage.py app db list shop
./manage.py app db create shop reporting
./manage.py db user-reset shop
./manage.py db shell
./manage.py db shell --user shop
./manage.py db backup
./manage.py db backup shop_app
./manage.py db backup --app shop
./manage.py db list-backups
./manage.py db restore runtime/backups/mysql84/<file>.sql --yes
```

Use `--mysql-service mysql57|mysql84|mysql97` when you run more than one major.

### MySQL data and recovery

#### What is durable by default

- Table data lives in Docker named volumes (`mysql84-data`, `mysql57-data`, `mysql97-data`; see `compose.yml`).
- Recreating a MySQL container keeps data **if** the volume is not removed.
- `docker compose down -v` **destroys** MySQL data. Do not use `-v` on production hosts unless you intend to wipe.

#### What is not covered without backups

- Accidental `DROP DATABASE` / bad app migration / logical corruption
- With `disable_log_bin` (default on 8.4/9.7), there is **no** point-in-time recovery from the binary log

#### Recommended recovery path

1. Schedule regular `./manage.py db backup` (host cron or manual before risky deploys)
2. Store/copy `runtime/backups/mysql84` (and other majors you run) off-box if the host disk is not enough
3. Restore with `./manage.py db restore <file.sql> --yes`

#### Crash vs human error

| Event | Default protection |
|-------|--------------------|
| Container crash / reboot | InnoDB recovery on the named data volume |
| `docker compose up -d` recreate | Volume keeps data |
| `docker compose down -v` | **Data loss** |
| Accidental DROP / bad migration | Logical dump restore only |
| PITR to minute X | Not available while binlog is disabled |

Optional binlog settings for experiments live in `config/mysql/conf.d/z-binlog.cnf.example`. Binlog is **opt-in**, increases disk I/O, and still needs logical dumps — it is not a managed RDS substitute. Default stock compose keeps binlog disabled.

MySQL error and slow-query logs are under `runtime/logs/<mysql_service>/` (`error.log`, `slow.log`; `long_query_time=2`). On first start the bind-mounted log dir must be writable by the container `mysql` user (often uid 999); if mysqld cannot create logs, `chmod 777 runtime/logs/mysql84` or `chown 999:999 runtime/logs/mysql84`.

## Performance choices

- Host networking for Nginx removes Docker port-map/NAT overhead.
- Unix sockets between Nginx and PHP-FPM avoid local TCP overhead.
- Versioned socket directories avoid conflicts between PHP versions.
- Nginx serves static files directly from a read-only `/home` mount.
- HTTP/3 (QUIC) is enabled on generated HTTPS vhosts.
- Global `proxy_cache` and `fastcgi_cache` zones are declared for vhosts to opt in.
- PHP, MySQL, Redis stay isolated on a Compose backend network.
- MySQL/Redis are not exposed with host ports by default.
- MySQL keeps per-session sort/read buffers at server defaults so concurrent PHP connections do not multiply multi-megabyte allocations; size `innodb_buffer_pool_size` for the host instead.
- Server defaults use utf8mb4 / utf8mb4_unicode_ci and `max_allowed_packet=64M` for dumps/migrations. First restart after redo capacity changes can take longer while redo files resize.
- PHP services wait for the default `mysql84` healthcheck before starting, reducing cold-boot connection refused races.

### MySQL memory

| Host RAM (approx) | Suggested `MYSQL_INNODB_BUFFER_POOL_SIZE` | Notes |
|-------------------|-------------------------------------------|--------|
| 1–2 GB | 256M | Shared with PHP/Nginx/Redis |
| 4 GB | 512M–1G | Default 512M for mysql84/mysql97 |
| 8 GB+ | 1G–2G | Leave headroom for PHP-FPM |

Buffer pool is **not** “all free RAM”; leave room for OS page cache, PHP, and Redis. Size must be a multiple of 128M (InnoDB chunk size). Set `MYSQL_INNODB_BUFFER_POOL_SIZE` in `.env` (see `.env.example`).

## Notes

- This stack targets Linux cloud servers. Docker Desktop host networking and Unix socket bind mounts can behave differently.
- Make sure host firewalls/security groups allow UDP/443 if you want HTTP/3 to be reachable.
- Keep existing Ansible for host bootstrap/security/Docker install; avoid installing host Nginx/PHP/MySQL/Redis for new servers.
