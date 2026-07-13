# bento — vibe-coding ops stack

bento is a Docker-based LEMP operations stack for vibe-coding workflows, with host-network Nginx, Unix-socket PHP-FPM, multi PHP versions, MySQL, Redis, per-app cron, supervised workers, and ACME-ready TLS.

It is optimized for production performance and DX around isolated apps. The primary deployable unit is an app slug:

```text
/home/<app_name>/www
```

In this stack that maps to:

```text
bento/runtime/home/<app_name>/www
```

## Architecture

- **Nginx** runs with `network_mode: host`
  - no Docker TCP/UDP port publishing
  - no bridge NAT for public HTTP/HTTPS traffic
  - binds directly to host `:80` / `:443` TCP and `:443` UDP for HTTP/3
- **Managed PHP-FPM versions** run as separate Debian Trixie-based containers:
  - a fresh stack manages only PHP 8.5
  - `./manage.py php add <version>` generates each version's FPM, runner, and CLI services in `compose.d/bento-php-versions.yml`
  - OPcache is installed only when `php -m` shows it is missing, so PHP 8.5 can use its built-in Zend OPcache without reinstalling it.
- **PHP-FPM exposes per-app Unix sockets** in versioned shared dirs:
  - host path: `bento/runtime/run/php-fpm/php85/<app_name>.sock`
  - nginx path: `/run/php-fpm/php85/<app_name>.sock`
  - PHP container path: `/run/php-fpm/<app_name>.sock`
- **Each app is a Linux user / PHP-FPM pool / MySQL user** inside PHP containers:
  - app home: `/home/<app_name>`
  - document root: `/home/<app_name>/www`
  - logs: `/home/<app_name>/logs`
- **PHP runtime is split by role** while sharing the same PHP image/version:
  - `php85` (and each added version) runs PHP-FPM and exposes sockets
  - `php85-runner` (and each added version's runner) runs Supervisord as PID 1
  - each runner supervises root-only maintenance, one app-owned Supercronic per app, and named long-running workers
  - `php85-cli` (and each added version's CLI role) is ephemeral for deploys/shells
  - deploy commands, Composer, cron, workers, and PHP-FPM use the same PHP binary/extensions
- **PHP connects to MySQL/Redis** over the Compose backend network:
  - MySQL hosts are managed versioned services (for example `mysql57:3306`, `mysql84:3306`)
  - `./manage.py mysql add <version>` generates a service with its own durable named volume
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
config/compose.yml              # upstream-owned core Compose stack
.env.example
manage.py                     # create apps/domains/crons and run app commands
docs/architecture.md          # current file-layout/architecture notes

docker/                       # Docker build contexts and image helper binaries
config/                       # committed stack config and templates
  nginx/                      # Nginx global config, snippets, templates, self-signed cert
  php/                        # PHP common config and templates
  mysql/                      # shared + versioned MySQL config and SQL templates
runtime/                      # mutable/generated/live data
  state/stack.json            # local source of truth for apps/domains/proxies/crons/workers
  generated/                  # disposable rendered config; regenerate with ./manage.py render
    nginx/vhosts/             # generated vhosts
    php/versions/             # generated PHP-FPM users/pools
    cron/php84/jobs/          # generated PHP 8.4 cron job snippets
    cron/php84/apps/          # merged app-owned Supercronic files
    cron/php85/jobs/          # generated PHP 8.5 cron job snippets
    cron/php85/apps/          # merged app-owned Supercronic files
    runner/php84/programs/    # generated Supervisord programs/groups
    runner/php85/programs/
  custom/                     # user-owned hooks and app-scoped vhost/pool templates
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
cd bento
cp .env.example .env
# edit MYSQL_ROOT_PASSWORD

./manage.py render   # stage full generation, then promote into runtime/generated
# ./manage.py apply  # same as render, then validate + reload running services

./dc build php85 php85-runner
# mysql84 is the default MySQL service.
./dc up -d --remove-orphans mysql84 redis php85 php85-runner nginx
# Add/start another version when needed:
# ./manage.py mysql add 5.7
# ./dc up -d mysql57
```

## Interactive DX

For guided operations, run the no-dependency Python wizard:

```bash
./manage.py
# or explicitly:
./manage.py wizard
./manage.py tui
```

The wizard keeps its main menu focused on **Create app**, **Manage app**, and **Show services status**. **Manage app** first selects an app, then exposes app-scoped domain (including TLS/ACME), database (including backup/restore), cron, supervised workers, shell, and permission-check actions. A failed permission check suggests and can launch an explicit repair. Managers present numbered listings, refresh after changes, preview mutating plans, and print equivalent CLI commands for common flows.

For a quick dashboard without entering the wizard:

```bash
./manage.py status
./manage.py status --check-nginx
```

Keep `config/compose.yml` upstream-owned. Put local Docker Compose customization in ignored `compose.override.yml`, `compose.local.yml`, or `compose.d/*.yml`. Use `./dc ...` as the short `docker compose` replacement (or `./manage.py compose ...`) so every local fragment is always included:

```bash
./dc config
./dc up -d
./dc logs -f nginx
```

App vhost and PHP-FPM pool templates can be made app-owned with `./manage.py app config customize <app> vhost|pool`; see `docs/customization.md` for the ownership model, examples, and edge cases.

## Create an app

Default PHP version comes from `.env` `DEFAULT_PHP_VERSION`. An app slug is stack-wide unique and becomes the Linux user, PHP-FPM pool, and MySQL user.

App-scoped commands (`exec`, `shell`, `cron create`, and re-running `app create` without `--php`) use the app's **recorded PHP version** by default. Pass `--php` on `app create` to set or migrate the primary runtime; `cron`, `exec`, and `shell` reject an explicit `--php` that does not match that primary version.

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
- `fpm_profile`: named PHP-FPM pool sizing (`ondemand`, `balanced`, `throughput`). New apps default to `DEFAULT_FPM_PROFILE` (usually `balanced`). Re-run `app create` with `--fpm-profile` to change; omit the flag to keep a recorded profile.
- `access_log`: optional Combined nginx access logs under `runtime/logs/nginx/apps/<app>.access.log` (off by default). Static assets still skip access logging.

```bash
# Low-traffic / many apps on one PHP version (no idle workers):
./manage.py app create blog blog.example.com --fpm-profile ondemand
# Higher concurrency (still bounded; size host RAM and PHP_FPM_PROCESS_MAX):
./manage.py app create api api.example.com --fpm-profile throughput

# Opt in to app-scoped access logs (analyze adhoc with GoAccess; no realtime daemon):
./manage.py app access-log enable shop
./manage.py app logs analyze shop                  # TUI via docker run allinurl/goaccess
./manage.py app logs analyze shop --html /tmp/shop.html
./manage.py logs rotate                            # rename + nginx -s reopen when over NGINX_ACCESS_LOG_MAX_SIZE
./manage.py app access-log disable shop
```

Retention is controlled in `.env` with `NGINX_ACCESS_LOG_MAX_SIZE` (default `100M`) and `NGINX_ACCESS_LOG_ROTATE` (default `14` archives). Rotation never reloads nginx config; it only reopens log file descriptors.

Trade-offs: `ondemand` saves memory when idle but pays a cold-start cost; `balanced` keeps a few spare workers (default); `throughput` pre-spawns more workers for busier apps. Observe worker RSS and request latency before raising profiles. Each PHP container also has a global `process.max` (default 32, build arg `PHP_FPM_PROCESS_MAX`); `./manage.py status` warns when the sum of configured `pm.max_children` on one version exceeds that cap.

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

The optional DB suffix, `app`, creates `shop_app` on the app's `mysql_service` (default: `.env` `DEFAULT_MYSQL_SERVICE`, usually `mysql84`, unless `--mysql-service` is passed). Supplying a database suffix requires the selected MySQL service to be ready; the command fails rather than recording a skipped database. `--no-mysql` cannot be combined with a database suffix. The app's MySQL user is `shop` on that service and has prefix grants for `shop_*` databases. MySQL grants escape wildcard characters in app names before granting access, so valid app names containing `_` do not broaden privileges.

MySQL credentials are written to `runtime/home/<app>/.credentials/<mysql_service>.env` (mode 600). Redis credentials are written separately to `runtime/home/<app>/.credentials/redis.env` (mode 600). Passwords are not printed to stdout. Shared mode is the default (`REDIS_APP_ACL=false`) and uses the stack's optional `REDIS_PASSWORD`, while retaining a per-app client prefix. Set `REDIS_APP_ACL=true` plus `REDIS_ADMIN_PASSWORD` to generate a unique user/password per app and enforce keys and Pub/Sub channels matching `<app>:*` server-side. Client-side prefix configuration is required in either mode. `DB_DATABASE` / full name is `{app}_{db_suffix}` when you pass a database suffix to `app create` or `db create`.

PHP app connection values:

```text
DB_HOST=mysql84
DB_PORT=3306
DB_DATABASE=shop_app
DB_USERNAME=shop
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_USERNAME=shop
REDIS_PASSWORD=<from redis.env>
REDIS_DB=0
REDIS_PREFIX=shop:
```

In shared mode, `REDIS_USERNAME` is empty and all apps authenticate with `REDIS_PASSWORD` (or no authentication if it is empty). Modern phpredis and Predis clients support ACL usernames. In ACL mode, an older password-only integration can use `REDIS_LEGACY_PASSWORD`; this enables the shared `default` user and weakens isolation. Changing ACL mode or its initial admin/legacy settings requires recreating Redis; changing `REDIS_ADMIN_PASSWORD` after ACL initialization requires explicit ACL rotation.

## App service configuration customization

Generated vhosts and PHP-FPM pools normally follow upstream templates. To take ownership of one template for a specific app:

```bash
./manage.py app config status shop
./manage.py app config customize shop vhost  # opens VISUAL, EDITOR, or vi
./manage.py app config customize shop pool   # saves, validates, then reloads
```

The editor must exit successfully before the selected custom source is recorded in `runtime/state/stack.json`, rendered transactionally into the normal `runtime/generated/` destination, validated, and reloaded. Custom templates still receive app variables and must preserve required TLS markers, identity, and Unix-socket settings. Use `--no-edit` for automation and `--no-reload` to validate without signaling the affected service.

Switch back to the current upstream template without deleting the custom source:

```bash
./manage.py app config reset shop vhost
./manage.py app config reset shop pool
```

The interactive wizard exposes the same flow under **Manage app → Customize**. `app config status` reports when a custom template was based on an older upstream template.

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

Use a separate app slug for a separate codebase; one app is one isolation unit (Linux user, FPM pool, MySQL user).

## Deploy app code and run Composer

Run app commands in an ephemeral matching PHP CLI container as the same Linux user used by PHP-FPM. Omit `--php` to use the app's recorded PHP version:

```bash
./manage.py shell
# or explicitly:
./manage.py shell shop
./manage.py exec shop -- git clone git@github.com:org/project.git .
./manage.py exec shop -- composer install
./manage.py exec shop -- php artisan migrate
```

SSH deploy keys can live in `runtime/home/shop/.ssh/` with normal SSH permissions.

## Cron jobs

Cron runs under Supervisord in the versioned `php84-runner` / `php85-runner` containers. Each app with cron jobs gets its own Supercronic child running directly as that app's private UID/GID. Root is reserved for a separate stack-maintenance scheduler. Create cron jobs per app; they inherit the app's recorded PHP version unless you pass a matching `--php`:

```bash
./manage.py cron create shop schedule '* * * * *' 'php artisan schedule:run'
./manage.py cron list
./manage.py cron reload --app shop
./manage.py cron remove shop schedule  # or: ./manage.py cron remove --number 1
```

This writes:

```text
runtime/generated/cron/php85/jobs/shop-schedule.cron
runtime/generated/cron/php85/apps/shop.cron
runtime/generated/cron/php85/system.cron
runtime/generated/runner/php85/programs/bento.conf
```

The app scheduler and all of its jobs run directly as `shop:shop`, from app-bounded workdirs, with the PHP 8.5 binary/extensions and the same environment as PHP-FPM. The non-privileged `php-cron-job` helper enforces optional timeout, lock, and file-output policy; it does not switch users. `manage.py` validates each app crontab, asks Supervisord to `reread`/`update` generated programs, then sends `SIGUSR2` to the named app scheduler rather than PID 1.

Every PHP runner receives a root-only `system.cron` containing daily maintenance. Do not scale a runner service to multiple replicas, or cron jobs and workers will run more than once.

Cron supports bounded workdirs, IANA timezones, timeouts, app-scoped shared locks, and optional private file output:

```bash
./manage.py cron create shop report '0 2 * * *' 'php artisan report:send' \
  --timezone Asia/Ho_Chi_Minh --timeout 1800 --lock reports
./manage.py cron create shop import '*/5 * * * *' 'php artisan import:run' \
  --output file
```

Default `--output docker` keeps application output with structured Supercronic lifecycle/exit logs. Docker's `local` logging driver rotates and compresses service stdout/stderr (`20m` × 5 files). `--output file` writes as the app user to `/home/<app>/logs/cron-<php-runner-service>-<job>.log`. The root maintenance scheduler rotates those files and PHP-FPM logs daily. Supercronic does not expose a metrics endpoint.

## Long-running workers

Workers are named app processes supervised alongside cron in the matching PHP runner. Supervisord starts them directly as the app UID/GID with explicit `HOME`, `COMPOSER_HOME`, workdir, and `umask 0027`; app commands never run as root. Guided create/list/status/start/stop/restart/remove is available under **Manage app → Workers** in `./manage.py wizard`.

```bash
# Laravel queue worker:
./manage.py worker create shop queue --stop-timeout 120 -- \
  php artisan queue:work redis --sleep=3 --tries=3 --timeout=90 --max-time=3600

# Horizon or a Node process using the Node 24 runtime bundled in the PHP image:
./manage.py worker create shop horizon -- php artisan horizon
./manage.py worker create shop consumer -- node dist/consumer.js

./manage.py worker list --app shop
./manage.py worker status shop
./manage.py worker restart shop queue
./manage.py worker stop shop queue
./manage.py worker start shop queue
./manage.py worker remove shop queue
```

Commands are stored as an argv list, not evaluated by a root shell. Shell syntax such as pipes or redirects must be explicit, for example `-- sh -lc 'command | command'`. Set Laravel's worker timeout lower than `retry_after`, and set `--stop-timeout` longer than the longest expected job. Use `--max-time` or `--max-jobs` to recycle long-lived PHP workers. A worker definition may also run the bundled Node version; use a dedicated app image/container when a different Node major, native system dependencies, host port, or stronger resource isolation is required.

Worker and cron processes share their versioned runner container as flat Supervisord programs (`cron-<app>`, `worker-<app>-<name>`), not process groups—so adding or removing one worker only starts/stops that program. They are isolated by UID/GID and filesystem policy, not by per-process cgroups. A runner restart affects all processes on that PHP version. App-wide `worker status|start|stop|restart <app>` expands worker names from state (cron is separate).

## Change an app's PHP version

Re-run `manage.py app create` with another `--php` version to migrate the **primary** PHP runtime. That is the supported migration path; `cron`/`exec`/`shell` will not change primary PHP version. It regenerates app identity and the Nginx vhost:

```bash
./manage.py app create shop shop.example.com --php 8.4
```

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

## Manage PHP versions

PHP versions are managed in stack state. The generated `compose.d/bento-php-versions.yml` contains FPM, runner, and CLI roles inheriting `x-common-php` properties.

```bash
./manage.py php versions
./manage.py php add 8.4
./dc up -d --build php84 php84-runner
./manage.py php remove 8.4   # rejected while any app uses PHP 8.4
```

The same add/remove flow is available in **Wizard → Manage PHP versions**. Reassign apps to another managed version before removing a runtime.

## Manage MySQL versions

MySQL versions are managed in stack state and rendered to `compose.d/bento-mysql-versions.yml`. Each version gets a stable service name and a dedicated named data volume. The CLI intentionally has **no remove command** because removing database topology is too easy to turn into data loss.

```bash
./manage.py mysql versions
./manage.py mysql add 5.7
./dc up -d mysql57
```

Back up and migrate databases manually before any intentional retirement.

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

`./manage.py render` stages a complete generation under `runtime/.render-txn-*/`, then promotes files atomically into bind-mounted destinations (`runtime/generated/`, `runtime/secrets/mysql/`). Stale managed files are removed only after the candidate set is complete; validation/reload failures roll generated files back (reload-signal failures after a successful validate leave the new generation for retry). See `docs/architecture.md` for the stage → promote → validate → rollback → reload lifecycle.

It also generates ignored, mode-600 root client option files under `runtime/secrets/mysql/` from the long random root password in `.env`. Each MySQL service mounts only its own file read-only at `/run/secrets/bento-root.cnf`; health checks and `manage.py` administrative commands use that file, so passwords are not passed in client command arguments. Re-run `./manage.py render` and recreate the affected MySQL container after changing a root password. Keep `.env` as the recovery source and never commit or copy these option files into images.

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
./manage.py db backup --gzip
./manage.py db backup --app shop --gzip --keep 14
./manage.py db list-backups
./manage.py db restore runtime/backups/mysql84/<file>.sql --yes
./manage.py db restore runtime/backups/mysql84/<file>.sql.gz --yes
```

`db shell` (root) uses the mounted root option file. `db shell --user <app>` reads the app credential file under `runtime/home/<app>/.credentials/` and transfers credentials into the MySQL container through a short-lived mode-600 option file created over stdin (random path under `/run`, removed after the session). App passwords are **not** placed in host `docker compose` command arguments. This protects process listings and host telemetry; the Docker daemon and container root can still observe in-container state for the duration of the shell.

Use `--mysql-service mysql57|mysql84|mysql97` when you run more than one major. Guided backup/restore is available via `./manage.py wizard` / `./manage.py tui` under **Manage app → Databases**.

#### Backup and restore semantics

- **Atomic final dumps:** `db backup` streams `mysqldump` into a private mode-600 partial file (name suffix `.partial-<token>`, never listed as a backup). On success the file is fsynced and promoted with same-filesystem `os.replace` to a unique `*.sql` or `*.sql.gz` name. Failed, interrupted, or empty dumps leave **no** final backup and clean up the partial on ordinary failure paths.
- **Gzip option:** `--gzip` pipes dump SQL through streaming gzip compression and writes `*.sql.gz`. Restore auto-detects `.sql.gz` and decompresses on the fly while streaming into `mysql`.
- **No overwrite of existing backups:** final names include a microsecond stamp (and a short random suffix if needed). Existing finalized dumps are never truncated or replaced.
- **Batch behavior:** one stamp per backup batch; if database *N* of *M* fails, earlier finalized dumps from that batch are kept, retention is **not** applied, and the error names the safely written files.
- **Listing / retention:** `db list-backups` and `--keep` consider only regular finalized `*.sql` / `*.sql.gz` files (partials and symlinks are ignored). `--keep N` requires `N >= 1` and runs only after the whole requested batch succeeds; omit `--keep` to retain all finalized dumps. `--keep 0` is rejected.
- **Streaming restore:** `db restore` streams the dump file on stdin to `mysql` (binary-safe; not loaded fully into Python memory). Restore may overwrite objects present in the dump; it is **not** atomic at the MySQL object level.
- **Off-box copies still required:** host-local finalized dumps are not a full disaster-recovery plan—copy `runtime/backups/<service>/` off the machine regularly.

### MySQL data and recovery

#### What is durable by default

- Table data lives in Docker named volumes (`mysql84-data`, `mysql57-data`, `mysql97-data`; see `config/compose.yml`).
- Recreating a MySQL container keeps data **if** the volume is not removed.
- `docker compose down -v` **destroys** MySQL data. `./dc down -v` and `./dc down --volumes` are blocked; do not bypass the wrapper on production hosts.

#### What is not covered without backups

- Accidental `DROP DATABASE` / bad app migration / logical corruption
- With `disable_log_bin` (default on 8.4/9.7), there is **no** point-in-time recovery from the binary log

#### Recommended recovery path

1. Schedule regular `./manage.py db backup` (host cron or manual before risky deploys); use `--keep N` (`N >= 1`) only when you intentionally prune old finalized dumps after a successful batch
2. Store/copy `runtime/backups/mysql84` (and other majors you run) off-box if the host disk is not enough
3. Restore with `./manage.py db restore <file.sql> --yes` (streams the dump; may overwrite objects)

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
- Redis supports shared compatibility mode by default and opt-in per-app ACL isolation with `REDIS_APP_ACL=true`. Logical DB 0 and per-app client prefixes are used in both modes.
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
