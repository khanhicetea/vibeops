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
  logs/                       # nginx/php logs
  certs/                      # externally managed cert files
  backups/                    # backups/dumps
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

The wizard can create apps, app domains, proxy vhosts, TLS/ACME config, cron jobs, open app shells, and show stack status. It previews the plan before applying changes and prints equivalent CLI commands for common flows.

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

The optional DB suffix, `app`, creates `shop_app` on the app's `mysql_service` (default: `.env` `DEFAULT_MYSQL_SERVICE`, usually `mysql84`, unless `--mysql-service` is passed). The app's MySQL user is `shop` on that service and has prefix grants for `shop_%`, so one app can own multiple databases.

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
```

This writes:

```text
runtime/generated/cron/php85/jobs/shop-schedule.cron
runtime/generated/cron/php85/.supercronic.cron
```

The job runs in the `php85-cron` container as `shop`, from `/home/shop/www`, with the PHP 8.5 binary/extensions and the same container environment as PHP-FPM. `manage.py` merges `jobs/*.cron` files into `runtime/generated/cron/php85/.supercronic.cron` and reloads Supercronic with `SIGUSR2`; if the cron container was idle before the first job, `manage.py` restarts it once to start Supercronic. Do not scale a cron service to multiple replicas, or jobs will run more than once.

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

## Important permission detail

The official Debian-based Nginx image runs workers as GID `101`. PHP-FPM sockets are created with `SOCKET_GID=101` via `.env`, so Nginx can access them across containers. App files are group-readable so Nginx can serve static assets directly.

For very large `/home/<app_name>` directories you can disable automatic recursive ownership fixes:

```env
FIX_HOME_OWNERSHIP=0
```

Then manage ownership yourself.

## Performance choices

- Host networking for Nginx removes Docker port-map/NAT overhead.
- Unix sockets between Nginx and PHP-FPM avoid local TCP overhead.
- Versioned socket directories avoid conflicts between PHP versions.
- Nginx serves static files directly from a read-only `/home` mount.
- HTTP/3 (QUIC) is enabled on generated HTTPS vhosts.
- Global `proxy_cache` and `fastcgi_cache` zones are declared for vhosts to opt in.
- PHP, MySQL, Redis stay isolated on a Compose backend network.
- MySQL/Redis are not exposed with host ports by default.

## Notes

- This stack targets Linux cloud servers. Docker Desktop host networking and Unix socket bind mounts can behave differently.
- Make sure host firewalls/security groups allow UDP/443 if you want HTTP/3 to be reachable.
- Keep existing Ansible for host bootstrap/security/Docker install; avoid installing host Nginx/PHP/MySQL/Redis for new servers.
