# VibeOps architecture and file layout

This repository separates upstream source, local desired state, disposable generated config, and live runtime data. The primary isolation unit is an app slug, which is also the Linux user, PHP-FPM pool, and MySQL user.

```text
compose.yml                 # upstream-owned service topology
compose.override.yml        # optional ignored local Docker Compose overrides
manage.py                   # thin CLI entrypoint into vibeops.cli
vibeops/                    # management CLI package (see module map below)

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
  logs/                     # nginx/php/mysql logs
    mysql57|mysql84|mysql97/ # mysqld error + slow query logs per service
  backups/mysql57|mysql84|mysql97/ # versioned logical database dumps
  certs/                    # external certificate files
  nginx-acme-state/         # NGINX ACME account/cert/key state
```

## Render/apply model

`runtime/state/stack.json` is the source of truth for apps, domains, proxy vhosts, TLS mode, and cron jobs. Files under `runtime/generated/` are disposable artifacts and should not be edited directly.

```bash
./manage.py render          # stage + promote a complete generation into runtime/generated
./manage.py apply           # render, validate running services, then reload
./manage.py state migrate   # move/upgrade legacy ./stack.json
```

Render and apply are transactional. Top-level bind-mounted directories (`runtime/generated/`, `runtime/secrets/mysql/`) stay in place; only file contents are replaced atomically. Lifecycle:

```text
state lock -> stage complete generation -> atomic per-file promotion -> validate all -> reload -> finalize
                                                    \-> rollback on failure
```

Details:

- **Stage**: build the full candidate tree under `runtime/.render-txn-*/staging/` (same filesystem as live destinations).
- **Promote**: per-file snapshot + temp write + `fsync` + `os.replace`; stale managed files are removed only after every candidate exists.
- **Validate** (`apply`): `nginx -t`, `php-fpm -tt`, and `supercronic -test` for affected running services before any reload signal.
- **Rollback**: on stage, promote, or validation failure, restore previous bytes and modes from the transaction backup.
- **Reload failure**: if validation succeeded but a reload signal fails, generated files stay at the validated generation; retry the service reload (do not auto-roll back).
- **Unmanaged files**: local files under managed globs that lack the VibeOps generated notice are left in place and reported.
- **Abandoned transactions**: a leftover mid-promotion journal is restored on the next render/apply when the journal is deterministic.

Users should customize Docker Compose with ignored override files instead of editing `compose.yml`:

```text
compose.override.yml        # auto-loaded by docker compose
compose.local.yml           # loaded by ./manage.py compose
compose.d/*.yml             # loaded by ./manage.py compose
```

Use `./manage.py compose ...` when you want all local fragments included. See `docs/customization.md` for examples, edge cases, and do/don't guidance.

## Identity and permission planes

Rendered `users.d/<app>.env` metadata records `USERNAME`, `UID`, matching private `GID`, and `PUBLIC_DIR`. PHP startup creates/reconciles only those Linux identities; it does not touch app homes. FPM workers use the app-private group, while the Unix socket remains group-owned by `nginxsock` for Nginx interoperability.

Filesystem policy is app-scoped: app creation initializes its small tree, while `./manage.py permissions check <app>` reports drift and `./manage.py permissions fix <app> [--recursive]` repairs existing trees explicitly. Private app paths remain `app:app`; the selected document root is setgid and group-readable/traversable by Nginx. CLI and cron commands run with the app's private UID/GID and `umask 0027`, so new public files inherit the Nginx-readable group. The reload lifecycle is:

```text
stage -> promote -> identity sync -> php-fpm -tt (validate all) -> reload
```

The non-Docker test suite validates command construction and safe validation on macOS; Linux container ownership, socket access, and Nginx access still require Linux/CI verification.

## Cron layout

Cron is version-scoped to match the Docker services:

```text
runtime/generated/cron/php84/jobs/*.cron
runtime/generated/cron/php84/.supercronic.cron
runtime/generated/cron/php85/jobs/*.cron
runtime/generated/cron/php85/.supercronic.cron
```

`manage.py cron create` writes one job file under `jobs/`, then atomically rebuilds `.supercronic.cron`. Every configured PHP version gets a valid combined crontab with an always-present daily maintenance entry, which keeps Supercronic running and reloadable even when there are no app jobs. A running scheduler validates the new file with `supercronic -test` before receiving `SIGUSR2`.

Supercronic remains root only as the scheduler. Each generated entry calls `php-cron-as`, which validates an app-bounded workdir and drops to the app's private UID/GID without provisioning or permission repair. Jobs inherit `umask 0027`, app `HOME`/Composer environment, and identifying `VIBEOPS_*` variables. Same-entry overlap is suppressed by Supercronic; optional app-scoped `flock` names coordinate related jobs, and optional GNU `timeout` limits runtime.

Operational output defaults to structured container stdout/stderr and Docker `local` driver rotation. File output is explicitly opt-in and writes as the app user below `/home/<app>/logs`. The always-present daily logrotate entry retains 14 date-suffixed cron and PHP-FPM log rotations; `copytruncate` preserves the app-owned live files. Supercronic exposes `/health` and `/metrics` on backend-only port 9746.

## App model

`runtime/state/stack.json` schema 5 stores PHP apps under `apps` and a stack-wide `domains` index for collision checks and TLS lookup. Each app records its selected MySQL service (`mysql_service`, plus host/port/user metadata); the default comes from `.env` `DEFAULT_MYSQL_SERVICE` unless `--mysql-service` is passed when creating the app/database. A PHP app vhost is named `runtime/generated/nginx/vhosts/app-<app_name>.conf`; proxy vhosts remain domain-keyed.

Filesystem layout for an app:

```text
runtime/home/<app_name>/
  www/
  logs/
  .credentials/
  .ssh/
  .composer/
```

All domains on an app share the same code tree under `/home/<app_name>/www` and `/run/php-fpm/<php_service>/<app_name>.sock`. The app's `public_dir` metadata selects the Nginx document root inside that tree: empty string means `/home/<app_name>/www` (WordPress/default), while `public` means `/home/<app_name>/www/public` (Laravel/Symfony). The app's `php_entrypoint` metadata controls PHP routing: `front-controller` only executes `/index.php` and 404s other `.php` paths, while `legacy` keeps direct PHP script execution for older apps. `auto` defaults to `front-controller` when `public_dir` is non-empty. Separate codebases should be separate apps.

App state stores a named `fpm_profile` (`ondemand`, `balanced`, or `throughput`). Render expands that name into mode-correct PHP-FPM pool directives from a single registry in `vibeops/env.py` — not arbitrary operator-supplied pool fragments. New apps take `DEFAULT_FPM_PROFILE` from `.env` (default `balanced`). Each PHP image also sets global `process.max` (default 32 via build arg `PHP_FPM_PROCESS_MAX`); per-pool `max_children` is additionally bounded by that cap, and status reports when configured capacity on one PHP version exceeds it.

## Management package module map

Dependency direction (lower layers must not import command/parser/wizard layers):

```text
errors / paths / validation
        ↓
env / fsutil / process / template / compose
        ↓
state / rendering / mysql / php / nginx / cron_runtime
        ↓
*_commands.py
        ↓
parser / cli / wizard_commands
```

| Module | Responsibility |
|---|---|
| `errors.py` | `StackError` and console output helpers |
| `paths.py` | Repo roots, runtime path constants, `RenderContext` |
| `validation.py` | Regexes and pure validators |
| `env.py` | `.env` parsing, stack defaults, FPM profile registry |
| `fsutil.py` | `mkdir` / atomic text writes |
| `process.py` | Subprocess helpers and Docker service discovery |
| `template.py` | Template engine (no service knowledge) |
| `compose.py` | Sole owner of Compose file selection and argv prefix |
| `state.py` | `stack.json` load/save, locks, timestamps, UID allocation |
| `rendering.py` | Generated headers and template-to-file writes |
| `mysql.py` | Option files, SQL grants, DB provisioning primitives |
| `php.py` | PHP service naming, identity/pool render, FPM reload |
| `nginx.py` | Vhost/TLS mutation and nginx reload |
| `cron_runtime.py` | Cron paths, aggregate crontab rebuild, scheduler reload |
| `*_commands.py` | CLI command handlers (stable callback names) |
| `parser.py` | Explicit argparse wiring to command modules |
| `cli.py` | Entrypoint / exit codes |
| `helpers.py` | Deprecated re-export shim only (no business logic) |

Rules for new code:

- Put validation in `validation.py`, env defaults in `env.py`, state mutations in `state.py`.
- Compose argv goes through `compose.py` (`compose_command` / `compose_prefix`).
- State writes use `state.py`; generated-file writes use `rendering.py` and the Plan 005 render transaction in `runtime_commands.py`.
- Parser and wizard are adapters: they call handlers, they do not own business logic.
- No wildcard imports (`from … import *`). Prefer explicit imports; module-qualified service APIs are fine when origin clarity matters.
- Foundational modules must not import `*_commands`, `parser`, `wizard_commands`, or `cli`.

## MySQL recovery model

- **Durable by default:** InnoDB data for each major lives in a named Docker volume (`mysql84-data`, etc.). Container recreate keeps data; `docker compose down -v` destroys it.
- **Human-error recovery:** use `./manage.py db backup` / `./manage.py db restore` and keep `runtime/backups/<service>/` copies off-box when needed.
- **Logical dump durability:** backups stream into a private partial file and are promoted atomically to a unique finalized `*.sql` or `*.sql.gz` path only after a successful non-empty dump (`--gzip` streams through compression). Partials are excluded from listing/retention. Restore streams plain or gzip dumps into `mysql` (not fully buffered in the Python process) and may overwrite objects; object-level restore is not atomic.
- **No PITR by default:** 8.4/9.7 conf keeps `disable_log_bin`. Logical dumps are the supported recovery path until an operator intentionally enables binlog (see `config/mysql/conf.d/z-binlog.cnf.example`).
- **Readiness:** PHP services depend on `mysql84` being healthy; each MySQL service exposes a `mysqladmin ping` healthcheck.
- **Credentials:** app MySQL passwords live only under `runtime/home/<app>/.credentials/` (mode 600); manage.py does not print them and does not put the root password on host process argv. Admin dump/restore use `/run/secrets/vibeops-root.cnf` inside the container.
