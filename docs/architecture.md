# bento architecture and file layout

This repository separates upstream source, local desired state, disposable generated config, and live runtime data. The primary isolation unit is an app slug, which is also the Linux user, PHP-FPM pool, and MySQL user.

```text
config/compose.yml          # upstream-owned service topology
compose.override.yml        # optional ignored local Docker Compose overrides
manage.py                   # thin CLI entrypoint into bento.commands.cli
bento/                    # management CLI package (see module map below)

docker/                     # Docker build contexts and image helper binaries
  php/
  redis/

config/                     # committed stack configuration and templates
  nginx/                    # host-network edge config, snippets, templates
  php/                      # PHP common config and templates
  mysql/                    # shared + versioned MySQL config and SQL templates

runtime/                    # local state/generated/live data
  state/stack.json          # source of truth for apps/domains/proxies/crons/workers
  generated/                # disposable rendered config; regenerate with ./manage.py render
    nginx/vhosts/           # generated vhosts; PHP apps use app-<app>.conf
    php/versions/*/         # generated PHP-FPM users and pools
    cron/php84|php85/       # per-job + per-app Supercronic state
    runner/php84|php85/     # generated Supervisord programs/groups
  custom/                   # user-owned customization hooks/compose adjuncts
    apps/<app>/nginx/       # optional app-owned vhost template
    apps/<app>/php/         # optional app-owned PHP-FPM pool template
  home/                     # mounted as /home into nginx/php; app homes live at <app>/www
  run/php-fpm/php84|php85/  # PHP-FPM Unix sockets
  logs/                     # nginx/php/mysql logs
    nginx/apps/             # opt-in per-app Combined access logs (<app>.access.log)
    mysql57|mysql84|mysql97/ # mysqld error + slow query logs per service
  backups/mysql57|mysql84|mysql97/ # versioned logical database dumps
  certs/                    # external certificate files
  nginx-acme-state/         # NGINX ACME account/cert/key state
```

## Render/apply model

`runtime/state/stack.json` is the source of truth for apps, domains, proxy vhosts, TLS mode, app service-template ownership, cron jobs, and long-running workers. Files under `runtime/generated/` are disposable artifacts and should not be edited directly. An app may select a user-owned vhost or pool template under `runtime/custom/apps/<app>/`; render still stages that source into `runtime/generated/` so validation and rollback semantics remain unchanged.

```bash
./manage.py render          # stage + promote a complete generation into runtime/generated
./manage.py apply           # render, validate running services, then reload
./manage.py state init      # create empty runtime/state/stack.json
```

Render and apply are transactional. Top-level bind-mounted directories (`runtime/generated/`, `runtime/secrets/mysql/`) stay in place; only file contents are replaced atomically. Lifecycle:

```text
state lock -> stage complete generation -> atomic per-file promotion -> validate all -> reload -> finalize
                                                    \-> rollback on failure
```

Details:

- **Stage**: build the full candidate tree under `runtime/.render-txn-*/staging/` (same filesystem as live destinations).
- **Promote**: per-file snapshot + temp write + `fsync` + `os.replace`; stale managed files are removed only after every candidate exists.
- **Validate** (`apply`): `nginx -t`, `php-fpm -tt`, Supervisor `reread` (parse-only), and `supercronic -test` for affected running services before any reload signal.
- **Selective targets**: full `apply` validates/reloads nginx + PHP-FPM + cron. Narrow mutations still re-render the full generation for consistency when they touch generated config, but only validate/reload the service groups they change.
- **Rollback**: on stage, promote, or validation failure, restore previous bytes and modes from the transaction backup.
- **Reload failure**: if validation succeeded but a reload signal fails, generated files stay at the validated generation; retry the service reload (do not auto-roll back).

### Reload scope by command

Service signals only (not file re-render). Contract tests live in `tests/test_reload_scope.py`.

| Command | nginx | php-fpm | runner | Notes |
|---|:---:|:---:|:---:|---|
| `app domain add/remove/set-main` | Y | — | — | vhost `server_name` only |
| `app access-log enable/disable` | Y | — | — | vhost access_log directive only |
| `proxy create` / `tls acme` / `tls cert` | Y | — | — | vhost TLS/upstream only |
| `app create` | Y | Y | — | identity/pool + vhost; no cron bounce |
| `logs rotate` | — | — | — | rename access logs + `nginx -s reopen` (no config reload) |
| `cron create/remove/reload` | — | — | Y | reconcile only the matching PHP runner |
| `worker create/remove` | — | — | Y | reconcile only the matching PHP runner |
| `worker start/stop/restart/status` | — | — | direct | named Supervisord process/group only |
| `app db create` / `db create` / `db user-reset` | — | — | — | MySQL + state only |
| `db backup` / `db restore` / shell / exec | — | — | — | no service reloads (existing app) |
| `apply` | Y | Y | Y | intentional full apply |
| `render` | — | — | — | files only |
- **Unmanaged files**: local files under managed globs that lack the bento generated notice are left in place and reported.
- **Abandoned transactions**: a leftover mid-promotion journal is restored on the next render/apply when the journal is deterministic.

Users should customize Docker Compose with ignored override files instead of editing `config/compose.yml`:

```text
compose.override.yml        # loaded by ./dc
compose.local.yml           # loaded by ./dc
compose.d/*.yml             # loaded by ./dc
```

Use `./dc ...` (or `./manage.py compose ...`) so all local fragments are included. See `docs/customization.md` for examples, edge cases, and do/don't guidance.

## Identity and permission planes

Rendered `users.d/<app>.env` metadata records `USERNAME`, `UID`, matching private `GID`, and `PUBLIC_DIR`. PHP startup creates/reconciles only those Linux identities; it does not touch app homes. FPM workers use the app-private group, while the Unix socket remains group-owned by `nginxsock` for Nginx interoperability.

Filesystem policy is app-scoped: app creation initializes its small tree, while `./manage.py permissions check <app>` reports drift and `./manage.py permissions fix <app> [--recursive]` repairs existing trees explicitly. Private app paths remain `app:app`; the selected document root is setgid and group-readable/traversable by Nginx. CLI and cron commands run with the app's private UID/GID and `umask 0027`, so new public files inherit the Nginx-readable group. The reload lifecycle is:

```text
stage -> promote -> identity sync -> php-fpm -tt (validate all) -> reload
```

The non-Docker test suite validates command construction and safe validation on macOS; Linux container ownership, socket access, and Nginx access still require Linux/CI verification.

## Runner, cron, and worker layout

Cron and long-running processes are version-scoped to match the PHP image:

```text
runtime/generated/cron/php85/jobs/*.cron       # individual state-rendered snippets
runtime/generated/cron/php85/apps/shop.cron    # all shop schedules
runtime/generated/cron/php85/system.cron       # root maintenance only
runtime/generated/runner/php85/programs/bento.conf
```

`php84-runner` / `php85-runner` run Supervisord as PID 1. Docker restarts the runner container; Supervisord restarts its children. Its root-only Unix control socket is not exposed on the backend network.

`manage.py cron create` writes one job snippet, then atomically rebuilds one merged crontab per app. Supervisord starts that app's Supercronic directly with `user=<app>`, explicit `HOME`/Composer environment, app workdir, and `umask 0027`. The non-privileged `php-cron-job` helper validates per-job workdirs and applies optional `flock`, timeout, and file-output policy. A separate root Supercronic runs only stack maintenance/logrotate. Supercronic does not bind a metrics port.

Runner changes validate Supervisord and all affected crontabs, then call `supervisorctl reread` and `update`. Because crontab bytes are external to program configuration, existing app schedulers receive `SIGUSR2` by process name after reconciliation. Adding the first cron creates a process; removing the final cron removes it. The runner service must never be scaled to multiple replicas.

Workers under `workers["<app>/<name>"]` store an argv list, app-bounded workdir, PHP version affinity, and graceful stop timeout. Generated programs use Supervisord's `user=` directly—no root command wrapper—as flat programs named `cron-<app>` and `worker-<app>-<name>` (no Supervisord process groups). That way `supervisorctl update` only starts/restarts programs whose individual config changed: adding a worker does not recycle the app's cron scheduler or sibling workers. `worker start|stop|restart|status` addresses one program or expands all of an app's workers from state through the private control socket. Worker and cron isolation is UID/GID/filesystem based; CPU and memory limits remain runner-wide.

Operational output defaults to the shared runner's stdout/stderr and Docker `local` driver rotation. Cron file output remains explicitly opt-in below `/home/<app>/logs`; root maintenance retains 14 date-suffixed cron and PHP-FPM rotations.

## App model

`runtime/state/stack.json` schema 1 stores PHP apps under `apps` and a stack-wide `domains` index for collision checks and TLS lookup. Each app records its selected MySQL service (`mysql_service`, plus host/port/user metadata); the default comes from `.env` `DEFAULT_MYSQL_SERVICE` unless `--mysql-service` is passed when creating the app/database. Optional `service_config.vhost` and `service_config.pool` records select `generated` or `custom` template ownership and retain the upstream template digest used to report update availability. A PHP app vhost is named `runtime/generated/nginx/vhosts/app-<app_name>.conf`; proxy vhosts remain domain-keyed.

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

App state stores a named `fpm_profile` (`ondemand`, `balanced`, or `throughput`). Render expands that name into mode-correct PHP-FPM pool directives from a single registry in `bento/utils/env.py` — not arbitrary operator-supplied pool fragments. New apps take `DEFAULT_FPM_PROFILE` from `.env` (default `balanced`). Each PHP image also sets global `process.max` (default 32 via build arg `PHP_FPM_PROCESS_MAX`); per-pool `max_children` is additionally bounded by that cap, and status reports when configured capacity on one PHP version exceeds it.

## Management package module map

Layout under `bento/`:

```text
utils/       errors, paths, validation, env, template
os/          fsutil, process
services/    compose, state, rendering, mysql, php, nginx, access_log, cron_runtime, runner, redis
ui/          decorations, table
commands/    *_commands, parser, cli
```

Dependency direction (lower layers must not import command/parser/wizard layers):

```text
utils (errors / paths / validation / env / template)
        ↓
os (fsutil / process)
        ↓
services (compose / state / rendering / mysql / php / nginx / cron_runtime / runner)
        ↓
ui (decorations / table)  — presentation only; may import utils
        ↓
commands (*_commands / parser / cli / wizard)
```

| Module | Responsibility |
|---|---|
| `utils/errors.py` | `StackError` and console output helpers |
| `utils/paths.py` | Repo roots, runtime path constants, `RenderContext` |
| `utils/validation.py` | Regexes and pure validators |
| `utils/env.py` | `.env` parsing, stack defaults, FPM profile registry |
| `utils/template.py` | Template engine (no service knowledge) |
| `os/fsutil.py` | `mkdir` / atomic text writes |
| `os/process.py` | Subprocess helpers and Docker service discovery |
| `services/compose.py` | Sole owner of Compose file selection and argv prefix |
| `services/state.py` | `stack.json` load/save, locks, timestamps, UID allocation |
| `services/rendering.py` | Generated headers and template-to-file writes |
| `services/app_config.py` | App service-template ownership, custom paths, and upstream provenance |
| `services/mysql.py` | Option files, SQL grants, DB provisioning primitives |
| `services/php.py` | PHP service naming, identity/pool render, FPM reload |
| `services/nginx.py` | Vhost/TLS mutation and nginx reload |
| `services/access_log.py` | App-scoped access log paths, rename+reopen rotation, GoAccess |
| `services/cron_runtime.py` | Per-job/per-app crontab paths and rebuild |
| `services/runner.py` | Supervisord program rendering, validation, and reconciliation |
| `ui/decorations.py` | Wizard headings, menus, screen borders, lists, indentation, and alerts |
| `ui/table.py` | Terminal table formatting (plain and bordered ASCII) |
| `commands/*_commands.py` | CLI command handlers (stable callback names) |
| `commands/parser.py` | Explicit argparse wiring to command modules |
| `commands/cli.py` | Entrypoint / exit codes |

Rules for new code:

- Put validation in `utils/validation.py`, env defaults in `utils/env.py`, state mutations in `services/state.py`.
- Compose argv goes through `services/compose.py` (`compose_command` / `compose_prefix`).
- State writes use `services/state.py`; generated-file writes use `services/rendering.py` and the render transaction in `commands/runtime_commands.py`.
- Parser and wizard are adapters: they call handlers, they do not own business logic.
- No wildcard imports (`from … import *`). Prefer explicit imports; module-qualified service APIs are fine when origin clarity matters.
- Foundational packages (`utils`, `os`, `services`, `ui`) must not import `bento.commands`.

## MySQL recovery model

- **Durable by default:** InnoDB data for each major lives in a named Docker volume (`mysql84-data`, etc.). Container recreate keeps data; `docker compose down -v` destroys it.
- **Human-error recovery:** use `./manage.py db backup` / `./manage.py db restore` and keep `runtime/backups/<service>/` copies off-box when needed.
- **Logical dump durability:** database-neutral backups (`--no-create-db`, without `--databases`) stream into a private partial file and are promoted atomically to a unique finalized `*.sql` or `*.sql.gz` path only after a successful non-empty dump (`--gzip` streams through compression). Default `DROP TABLE IF EXISTS` output remains enabled. Partials are excluded from listing/retention. Restore explicitly selects either a new `<old_db>_<suffix>` database or a dropped-and-recreated original database, then streams plain or gzip SQL into it (not fully buffered in Python); object-level restore is not atomic. Replacing the original requires exact database-name confirmation.
- **No PITR by default:** 8.4/9.7 conf keeps `disable_log_bin`. Logical dumps are the supported recovery path until an operator intentionally enables binlog (see `config/mysql/conf.d/z-binlog.cnf.example`).
- **Readiness:** PHP services depend on `mysql84` being healthy; each MySQL service exposes a `mysqladmin ping` healthcheck.
- **Credentials:** app MySQL passwords live only under `runtime/home/<app>/.credentials/` (mode 600); manage.py does not print them and does not put the root password on host process argv. Admin dump/restore use `/run/secrets/bento-root.cnf` inside the container.
