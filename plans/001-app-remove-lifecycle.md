# Plan 001: Add `app remove` with safe, explicit teardown

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- vibeops/commands/app_commands.py vibeops/commands/parser.py vibeops/commands/wizard_commands.py vibeops/services/php.py vibeops/services/nginx.py vibeops/services/state.py vibeops/services/cron_runtime.py tests/ docs/architecture.md README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (destructive command; wrong defaults can delete homes/DBs)
- **Depends on**: none
- **Category**: direction / dx / feature
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

VibeOps can create isolated apps (Linux user, PHP-FPM pool, nginx vhost, domains, optional MySQL user/DBs, crons) but cannot tear them down through the CLI. Operators must hand-edit `runtime/state/stack.json`, delete generated pool/vhost files, and hope nothing is left behind. That produces state drift and leftover FPM pools. A first-class `app remove` with explicit flags for home and database destruction makes multi-tenant ops complete and safe.

## Current state

- **CLI surface**: `app create|list|show|domain|db|config|access-log|logs` exist; **no** `app remove` / `app delete`.
  - `vibeops/commands/parser.py` — app subparsers (around lines 30–146)
- **Create path**: `cmd_app_create` in `vibeops/commands/app_commands.py` builds identity + vhost + optional DB via `ensure_app_identity` / `apply_generated_config`.
- **Teardown exemplar**: `cmd_cron_remove` removes state + job file + reloads only that PHP cron service:

```python
# vibeops/commands/cron_commands.py (pattern to match for cleanup + reload)
cron_path.unlink(missing_ok=True)
db["crons"].pop(cron_key, None)
combined_crontab = rebuild_supercronic_crontab(php_version)
cron_reload(php_cron_service_for(php_version))
save_db(db)
```

- **State shape** (`empty_db` / `normalize_db` in `vibeops/services/state.py`):
  - `apps[app_name]` — app record
  - `domains[domain] = {kind: "php", app: app_name}`
  - `crons["app/job"]` may reference app
  - `users` may still hold legacy identity keys (clean if present)
- **Generated files for an app** (must be removed from state so next full render does not recreate them; live files under `runtime/generated/` are removed by apply’s stale-file cleanup when no longer rendered):
  - vhost: `runtime/generated/nginx/vhosts/app-<app>.conf` via `app_vhost_path`
  - pool: `runtime/generated/php/versions/<ver>/pool.d/<app>.conf`
  - user env: `runtime/generated/php/versions/<ver>/users.d/<app>.env`
  - cron job files under `runtime/generated/cron/phpXX/jobs/` for that app
- **App home**: `runtime/home/<app>/` via `app_home` in `vibeops/services/php.py`
- **Reload scopes**: app identity/pool changes use nginx + php; domain-only uses nginx. See `tests/test_reload_scope.py` matrix and `SERVICE_TARGETS_*` in `vibeops/commands/runtime_commands.py`:

```python
SERVICE_TARGETS_ALL = frozenset({"nginx", "php", "cron"})
SERVICE_TARGETS_NGINX = frozenset({"nginx"})
```

- **Conventions**:
  - Validate names with `APP_NAME_RE` / `validate(...)` from `vibeops/utils/validation.py`
  - State mutations that race with cron should use `@serialized_cron_state` or `cron_state_lock` when touching crons
  - Prefer `die` / `info` / `warn` from `vibeops/utils/errors.py`
  - Destructive actions require `--yes` for non-TTY (mirror `db restore`)
  - Layering: business logic in `commands` + `services`; parser only wires argparse

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Syntax + tests | `make check` | `syntax ok`, all tests pass |
| Tests only | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v` | all pass |
| Single test module | `python3 -B -m unittest tests.test_app_remove -v` | all pass (after you create it) |
| CLI help | `./manage.py app remove --help` | shows flags; exit 0 |

## Scope

**In scope**:
- `vibeops/commands/app_commands.py` — `cmd_app_remove` (+ helpers if needed)
- `vibeops/commands/parser.py` — wire `app remove` (alias `delete`)
- `vibeops/commands/wizard_commands.py` — optional Manage app → Remove (only if existing manage-app menu is easy to extend without redesign)
- `vibeops/services/php.py` — optional pure helpers for pool/user env paths if missing (keep small)
- `tests/test_app_remove.py` — new characterization/unit tests
- `tests/test_reload_scope.py` — add row for `app remove`
- `docs/architecture.md` — reload matrix row for `app remove`
- `README.md` — short section under app lifecycle (create counterpart)

**Out of scope**:
- Dropping MySQL *server* data volumes
- Automatically `DROP USER` / `DROP DATABASE` without an explicit flag
- Deleting Linux UIDs from running containers beyond normal identity sync (removing pool/env is enough; leftover UID in `/etc/passwd` is acceptable unless you find an existing identity-delete helper — do **not** invent complex userdel across versions)
- `proxy remove` (plan 002)
- Refactoring `runtime_commands.py`

## Git workflow

- Branch: `advisor/001-app-remove` (or `feat/app-remove`)
- Commit style: short imperative, e.g. `app remove lifecycle`
- Do **not** push or open a PR unless the operator asks

## Product behavior (authoritative)

Implement exactly this contract:

```text
./manage.py app remove <app_name> [--yes] [--purge-home] [--drop-mysql]
                        [--no-reload]
```

1. **Always** (after confirmation / `--yes`):
   - Remove app from `db["apps"]`
   - Remove all `db["domains"]` entries with `kind=="php"` and `app==app_name`
   - Remove all `db["crons"]` entries whose app matches; delete their job files; rebuild supercronic for affected PHP versions
   - Remove legacy `db["users"][app_name]` if present
   - Call `apply_generated_config` so vhost/pool/user.env for the app disappear from generated tree
   - Reload targets: **nginx + php** for the app’s PHP version; **cron** only if any crons were removed (if applying full service targets is simpler and already tested, using nginx+php always and cron when crons existed is preferred)

2. **`--purge-home`**: delete `runtime/home/<app>/` with `shutil.rmtree` after state is saved/apply succeeds. Without this flag, leave the home directory intact and print a warn that code/credentials remain.

3. **`--drop-mysql`**: if MySQL service is running and root option file is available, run SQL to `DROP DATABASE` for each recorded database name in the app record **and** `DROP USER` for the app MySQL user on that service. If MySQL is down, `die` with a clear message (do not half-remove state) **unless** the operator also passed a documented `--force-state-only` — **do not implement force flags** in this plan; require MySQL when `--drop-mysql` is set.

4. **Confirmation**:
   - Interactive TTY without `--yes`: print plan (what will be removed) and require typing the app name to confirm
   - Non-TTY without `--yes`: `die` asking for `--yes`
   - Mirror password/restore patterns: never print MySQL passwords

5. **Idempotency**: unknown app → `die` with `Unknown app: …`

## Steps

### Step 1: Characterization tests first

Create `tests/test_app_remove.py` modeled after `tests/test_reload_scope.py` and `tests/test_access_log.py`:

- Mock `apply_generated_config`, Docker, MySQL as needed
- Cases:
  1. Removes app + domains from state; calls apply with php+nginx targets
  2. Removes crons for that app and rebuilds crontab (mock)
  3. Without `--purge-home`, does not call rmtree on home
  4. With `--purge-home`, removes home path
  5. Without `--yes` on non-TTY, raises / dies
  6. Parser exposes `app remove` and `app delete` alias

**Verify**: `python3 -B -m unittest tests.test_app_remove -v` — tests may fail until implementation; write them to define the API, then implement until green.

### Step 2: Implement `cmd_app_remove`

In `vibeops/commands/app_commands.py`:

- Add `cmd_app_remove(args)`
- Use `load_db` / `save_db` / `upsert_timestamp` not needed on delete
- Import `apply_generated_config` and service targets from `runtime_commands` lazily (same style as domain commands)
- For cron cleanup, reuse helpers from `cron_commands` / `cron_runtime` rather than duplicating crontab merge logic
- For MySQL drop, add a small function in `vibeops/services/mysql.py` only if needed, e.g. `drop_app_mysql_resources(app_name, mysql_service, databases: list[str])` using existing `mysql_root_exec_sql` and `mysql_string_literal` — **identifiers must be validated** against `APP_NAME_RE` / `DB_NAME_RE` before interpolation

**Verify**: unit tests green for state/reload cases.

### Step 3: Wire parser

In `vibeops/commands/parser.py` under `app` subparsers:

```python
app_remove = app_sub.add_parser("remove", aliases=["delete"], help="Remove an app from state and generated config")
app_remove.add_argument("app_name")
app_remove.add_argument("--yes", action="store_true", help="Skip confirmation (required non-interactively)")
app_remove.add_argument("--purge-home", action="store_true", help="Delete runtime/home/<app>/")
app_remove.add_argument("--drop-mysql", action="store_true", help="DROP app databases and MySQL user")
app_remove.add_argument("--no-reload", action="store_true")
app_remove.set_defaults(func=app_commands.cmd_app_remove)
```

**Verify**: `./manage.py app remove --help` shows flags; `./manage.py app delete --help` works.

### Step 4: Reload-scope contract test

Extend `tests/test_reload_scope.py` matrix comment and add a test that `app remove` passes service_targets containing nginx and php (and cron if crons present).

**Verify**: `python3 -B -m unittest tests.test_reload_scope -v` passes.

### Step 5: Docs

- `docs/architecture.md` — add row to reload scope table for `app remove`
- `README.md` — short “Remove an app” snippet next to create docs

**Verify**: docs mention `--purge-home` and `--drop-mysql` defaults (safe: keep home, keep MySQL).

### Step 6: Full gate

**Verify**: `make check` → all pass.

### Step 7: Optional wizard entry

Only if Manage app menu already has a clear place for destructive actions: add “Remove app” that prints the CLI equivalent and requires name confirmation. If the wizard file is too tangled, skip and note in PR/plan maintenance notes.

## Test plan

| Case | File |
|------|------|
| State cleanup of apps/domains | `tests/test_app_remove.py` |
| Cron cleanup | same |
| `--purge-home` flag | same |
| Confirmation / `--yes` | same |
| Reload targets | `tests/test_reload_scope.py` |
| Module import invariants still hold | `tests/test_module_invariants.py` (existing) |

Pattern: mock Docker and MySQL like `tests/test_reload_scope.py`.

## Done criteria

- [ ] `./manage.py app remove --help` and `app delete --help` work
- [ ] `make check` exits 0
- [ ] New tests cover happy path + safe defaults (no home purge, no MySQL drop without flags)
- [ ] Default remove does **not** delete `runtime/home/<app>` without `--purge-home`
- [ ] Default remove does **not** DROP MySQL without `--drop-mysql`
- [ ] Architecture reload matrix documents the command
- [ ] No files outside scope modified without reason
- [ ] `plans/README.md` status → `DONE`

## STOP conditions

- App records store databases under a key structure that does not match what you assumed (`databases` list vs `database_services`) — open `cmd_app_create` / live `stack.json` schema and re-read before dropping MySQL objects
- Identity sync requires keeping empty pool files — do not invent container userdel across all PHP versions without an existing helper
- Wizard changes balloon into TUI redesign — skip wizard, finish CLI
- Any temptation to run `rm -rf runtime/home` without `--purge-home`

## Maintenance notes

- Reviewers must check confirmation UX and SQL identifier quoting for `--drop-mysql`
- Future: soft-delete / recycle-bin for apps; off-box backup reminder before drop
- After this lands, plan 002 (proxy remove) can reuse confirmation patterns
