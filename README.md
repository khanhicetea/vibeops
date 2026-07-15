# bento

bento is a Docker operations stack for hosting isolated PHP applications on one Linux server. It combines host-network Nginx, versioned PHP-FPM runtimes, MySQL, Redis, supervised cron and workers, and ACME TLS behind a dependency-free Python management CLI.

The app is the isolation unit. An app slug becomes its Linux user, PHP-FPM pool, MySQL user, and home directory:

```text
runtime/home/<app>/
├── www/          # application code
├── logs/
├── .credentials/ # generated MySQL and Redis credentials
├── .ssh/
└── .composer/
```

## Requirements

- Linux server with Docker Engine and Docker Compose v2
- Python 3.11 or newer
- Ports `80/tcp`, `443/tcp`, and optionally `443/udp` available on the host
- Public DNS pointing at the server before enabling ACME

Docker Desktop is useful for development, but host networking and Unix-socket mounts are designed for Linux production hosts.

## Stack

- **Nginx** uses `network_mode: host` and binds host ports directly. Its Bento image enables Zstandard response compression by default, retains gzip as a compatibility fallback, and enables HTTP/3 on generated HTTPS vhosts.
- **PHP** is managed by version. Every version has an FPM service, a Supervisord runner, and an ephemeral CLI service. A fresh stack contains PHP 8.5.
- **PHP-FPM** creates one Unix socket per app. For PHP 8.5, the host path is `runtime/run/php-fpm/php85/<app>.sock` and Nginx sees `/run/php-fpm/php85/<app>.sock`.
- **MySQL** is managed by version. Every version gets a separate service and durable named volume. A fresh stack contains MySQL 8.4.
- **Redis** is private to the Compose backend network. Shared-password mode is the default; optional ACL mode creates one Redis identity per app.
- **Cron and workers** run in the PHP version's runner container under the app's UID/GID, never as root.
- **Nginx reads app files read-only** while PHP and runner services mount them read-write.

MySQL, Redis, and PHP are not published on host ports.

## Repository layout

```text
config/compose.yml                 # upstream core Compose topology
compose.d/bento-php-versions.yml   # generated managed PHP services
compose.d/bento-mysql-versions.yml # generated managed MySQL services
compose.override.yml               # optional ignored local override
compose.local.yml                  # optional ignored local override

docker/                            # PHP and Redis image build contexts
config/                            # tracked Nginx/PHP/MySQL config and templates
bento/                             # stdlib-only Python management package
manage.py                          # management CLI entrypoint
dc                                 # Compose wrapper

runtime/state/stack.json           # local desired state
runtime/generated/                 # disposable rendered configuration
runtime/custom/                    # user-owned custom templates/config
runtime/home/                      # app homes
runtime/run/php-fpm/               # shared FPM sockets
runtime/backups/                   # logical MySQL dumps
runtime/certs/                     # externally managed certificates
runtime/nginx-acme-state/           # ACME accounts, certs, and private keys
runtime/logs/                      # service and optional app access logs
runtime/secrets/                   # generated local service credentials
```

Do not edit files under `runtime/generated/`. Change state through `manage.py`, or use the supported custom templates and Compose overrides described in [docs/customization.md](docs/customization.md).

## Quick start

```bash
git clone <repository-url> bento
cd bento
cp .env.example .env
${EDITOR:-vi} .env                  # set long MySQL and Redis passwords

./manage.py render                  # initialize state and generated config
./dc up -d --build                  # start mysql84, redis, php85, runner, nginx
./manage.py status --check-nginx
```

`./dc` is the supported short form for `./manage.py compose`. It always loads `config/compose.yml`, generated version fragments, and local `compose.override.yml`, `compose.local.yml`, and `compose.d/*.{yml,yaml}` files.

On a production host, check that another web server is not already using the host ports:

```bash
ss -ltnp '( sport = :80 or sport = :443 )' || true
ss -lunp '( sport = :443 )' || true
```

For guided operation, run `./manage.py` (or `./manage.py wizard`). The wizard is interactive and shows the equivalent CLI commands, so this README documents the scriptable CLI only.

## Create and deploy an app

Create a default document-root app with a database:

```bash
./manage.py app create shop shop.example.com app \
  --php 8.5 \
  --alias www.shop.example.com
```

Create a Laravel/Symfony-style front-controller app:

```bash
./manage.py app create shop shop.example.com app \
  --public-dir public \
  --php-entrypoint front-controller
```

A non-empty `--public-dir` automatically selects front-controller mode unless `--php-entrypoint legacy` is supplied. Without `--public-dir`, the root is `/home/<app>/www` and legacy direct-PHP routing is used.

The optional positional database suffix creates `<app>_<suffix>`. For the first example:

```text
DB_HOST=mysql84
DB_PORT=3306
DB_DATABASE=shop_app
DB_USERNAME=shop
DB_PASSWORD=<runtime/home/shop/.credentials/mysql84.env>
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PREFIX=shop:
```

Redis authentication values are in `runtime/home/shop/.credentials/redis.env`. Configure the application to apply its app prefix even in shared Redis mode.

Deploy code with the ephemeral CLI service. It automatically uses the app's recorded PHP version and UID/GID:

```bash
./manage.py shell shop
./manage.py exec shop -- git clone git@github.com:org/project.git .
./manage.py exec shop -- composer install --no-dev --optimize-autoloader
./manage.py exec shop -- php artisan migrate --force
```

Useful app commands:

```bash
./manage.py app list
./manage.py app show shop
./manage.py app domain add shop alt.shop.example.com
./manage.py app domain set-main shop alt.shop.example.com
./manage.py app domain remove shop www.shop.example.com
./manage.py app db create shop reporting
```

An app is tied to one MySQL service. Moving it to another MySQL version requires an explicit database migration; bento will not create the same app identity on multiple MySQL services.

## TLS

Generated vhosts start on the bundled self-signed certificate so Nginx can start before DNS is ready. After the main domain and every required alias resolve to the server:

```bash
./manage.py tls acme shop.example.com
```

This records ACME mode, renders the vhost, validates Nginx, and reloads it. Return to self-signed mode with:

```bash
./manage.py tls acme shop.example.com --off
```

For externally managed certs, put files under `runtime/certs/` and select them:

```bash
./manage.py tls cert shop.example.com
# defaults to /etc/letsencrypt/live/shop.example.com/{fullchain.pem,privkey.pem}

./manage.py tls cert shop.example.com \
  --cert /etc/letsencrypt/live/shop.example.com/fullchain.pem \
  --key /etc/letsencrypt/live/shop.example.com/privkey.pem
```

Keep `runtime/nginx-acme-state/` private and backed up; it contains private keys.

## Reverse proxies

Nginx uses the host network, so `127.0.0.1` inside Nginx is the host network namespace:

```bash
./manage.py proxy create api.example.com http://127.0.0.1:3000 \
  --alias www.api.example.com
./manage.py tls acme api.example.com
```

The upstream may also be a private IP reachable from the host. Compose service DNS is not available to host-network Nginx unless separately exposed/routed.

## Response compression

The default Bento Nginx image builds pinned dynamic modules from [myguard-labs/nginx-zstd-module](https://github.com/myguard-labs/nginx-zstd-module). Supporting clients receive Zstandard; gzip remains enabled for compatibility, and Brotli is not included. Precompressed `.zst` siblings are served when present.

Rebuild Nginx whenever its base image or the pinned module revision changes:

```bash
./dc build nginx
./dc up -d --no-deps nginx
./dc exec -T nginx nginx -t
```

See [docs/nginx-zstd.md](docs/nginx-zstd.md) for configuration, verification, and the existing-host upgrade order.

## PHP versions

```bash
./manage.py php versions
./manage.py php add 8.4
./dc up -d --build php84 php84-runner
```

Each managed version generates `phpXX`, `phpXX-runner`, and profile-gated `phpXX-cli` services. Move an app's primary runtime by re-running `app create` with its main domain:

```bash
./manage.py app create shop shop.example.com --php 8.4
```

Remove an unused version only after all apps have moved away from it:

```bash
./manage.py php remove 8.5
```

FPM sizing is selected per app with `--fpm-profile ondemand|balanced|throughput`. `DEFAULT_FPM_PROFILE` defaults to `balanced`; `PHP_FPM_PROCESS_MAX` is an image build-time global cap.

## MySQL versions and administration

```bash
./manage.py mysql versions
./manage.py mysql add 5.7
./dc up -d --build mysql57

./manage.py db shell --mysql-service mysql57
./manage.py db stats --mysql-service mysql57
./manage.py db process-list --mysql-service mysql57
```

There is intentionally no MySQL remove command. Retire a version only after manual backup/migration and deliberate removal of its service and named volume.

Every managed MySQL service builds a thin Bento image from its selected upstream MySQL tag. The wrapper installs `bash`, `gzip`, and `zstd` so backup and restore pipelines run beside the matching MySQL client tools. On ARM64, MySQL 5.7 instead uses `docker/mysql/5.7/Dockerfile`, based on `biarms/mysql:5.7`, and also wraps its entrypoint to prepare the bind-mounted log directory. After upgrading an existing host, run `./manage.py render && ./dc up -d --build <mysql-service>` once to build and activate the wrapper. MySQL 5.7 is end-of-life.

### Backups and restore

```bash
./manage.py db list --mysql-service mysql84
./manage.py db backup --zstd --keep 14
./manage.py db backup --app shop --zstd
./manage.py db list-backups
```

Backups are streamed to private partial files and atomically promoted to `.sql` or `.sql.zst` files in `runtime/backups/<mysql-service>/`. With `--zstd`, the MySQL container runs `mysqldump | zstd -3 -T1`; only compressed output crosses the Docker exec boundary. Restore sends compressed input into the container and runs `zstd -d | mysql`, or `gzip -d | mysql` for legacy `.sql.gz` dumps. These pipelines use Bash `pipefail`, and no host compression tools are required. `--keep N` applies per database only after the full requested batch succeeds.

Restore to a new database:

```bash
./manage.py db restore runtime/backups/mysql84/<dump>.sql.zst \
  --database shop_app \
  --new-suffix restored
```

Replace the original database only with exact-name confirmation:

```bash
./manage.py db restore runtime/backups/mysql84/<dump>.sql.zst \
  --database shop_app \
  --confirm-database shop_app
```

Restores are streamed but are not transactionally atomic at the MySQL object level. Keep off-host copies of logical dumps. Named volumes survive container recreation, but `docker compose down -v` destroys them; `./dc` blocks `down -v` and `down --volumes`.

## Cron

One app-owned Supercronic process is supervised for each app that has schedules:

```bash
./manage.py cron create shop scheduler '* * * * *' 'php artisan schedule:run'
./manage.py cron create shop report '0 2 * * *' 'php artisan report:send' \
  --timezone Asia/Ho_Chi_Minh \
  --timeout 1800 \
  --lock reports
./manage.py cron list --app shop
./manage.py cron remove shop report
```

Output defaults to Docker logs. `--output file` writes a private file under the app's `logs/` directory. Never scale a PHP runner above one replica or schedules and workers will run more than once.

## Long-running workers

```bash
./manage.py worker create shop queue --stop-timeout 120 -- \
  php artisan queue:work redis --sleep=3 --tries=3 --timeout=90 --max-time=3600

./manage.py worker list --app shop
./manage.py worker status shop
./manage.py worker restart shop queue
./manage.py worker stop shop queue
./manage.py worker start shop queue
./manage.py worker remove shop queue
```

Worker commands are stored as argv, not evaluated by a shell. Use `-- sh -lc '...'` explicitly when pipes, redirects, or other shell syntax are required.

## Render, apply, and status

`runtime/state/stack.json` is the source of truth. Rendering stages a complete candidate generation and atomically promotes it:

```bash
./manage.py render       # files only
./manage.py apply        # render, validate running services, reload affected roles
./manage.py status
./manage.py status --check-nginx
./dc ps
./dc logs -f nginx
```

Most state-mutating commands already render, validate, and narrowly reload the affected service. Use `--no-reload` where supported for planned batch changes, then run `./manage.py apply`.

## Permissions and identities

App users have private UID/GID identities. Nginx gets public-tree access through the shared socket group, normally GID `101`. Startup synchronizes identities but intentionally does not recursively rewrite app trees.

```bash
./manage.py identity sync shop
./manage.py identity sync --all
./manage.py permissions check shop
./manage.py permissions fix shop --recursive --dry-run
./manage.py permissions fix shop --recursive
```

Use an explicit recursive repair after importing files with incorrect ownership or modes.

## Access logs

Per-app access logs are off by default:

```bash
./manage.py app access-log enable shop
./manage.py app access-log status shop
./manage.py app logs analyze shop
./manage.py app logs analyze shop --html /tmp/shop.html
./manage.py logs rotate
./manage.py app access-log disable shop
```

The access-log format records Nginx's end-to-end `$request_time` and raw `$upstream_response_time`. GoAccess uses request time for its serving-time and slow-request views.

The Nginx image uses s6-overlay with Nginx as its main command and Supercronic as a supervised support service. At 03:17 daily, a locked maintenance script generates static reports and runs logrotate with `NGINX_ACCESS_LOG_MAX_SIZE` and `NGINX_ACCESS_LOG_ROTATE`. The generated logrotate policy uses `sharedscripts`, `delaycompress`, and a bounded `postrotate` hook that calls `nginx -s reopen`. Reports are available only on host loopback at `http://127.0.0.1:8080/goaccess/`. `GOACCESS_TIMEOUT_SECONDS` limits each report job; a report failure preserves the previous report and does not affect Nginx. Manual `manage.py logs rotate` commands invoke the same locked in-container logrotate implementation and persistent state file.

After an upgrade that introduces or changes Nginx maintenance dependencies, rebuild and recreate Nginx. An opt-in lifecycle check validates config testing, reload, reopen, maintenance, and the loopback endpoint:

```bash
./dc build nginx
./dc up -d --no-deps nginx
make test-nginx-integration
```

## Configuration and safety

Use `.env` for stack defaults and secrets. Use ignored Compose overlays for local service changes:

```text
compose.override.yml
compose.local.yml
compose.d/*.yml
compose.d/*.yaml
```

Inspect the merged model after changing an overlay:

```bash
./dc config
```

App-specific complete vhost and FPM-pool templates are supported:

```bash
./manage.py app config status shop
./manage.py app config customize shop vhost
./manage.py app config customize shop pool
./manage.py app config reset shop vhost
```

See [docs/customization.md](docs/customization.md) before overriding mounts or templates. See [docs/architecture.md](docs/architecture.md) for state, rendering, and process details.

Never commit or casually delete:

- `.env`
- `runtime/home/`
- `runtime/state/`
- `runtime/secrets/`
- `runtime/backups/`
- `runtime/certs/`
- `runtime/nginx-acme-state/`
- MySQL or Redis named volumes

Do not expose MySQL or Redis publicly, change `SOCKET_GID` without matching Nginx, edit generated files, or replace host-network Nginx without redesigning ingress.

## Development

```bash
make check
./manage.py --help
./manage.py <command> --help
```

The management CLI has no third-party runtime dependencies. The test suite uses Python's standard-library `unittest` runner.
