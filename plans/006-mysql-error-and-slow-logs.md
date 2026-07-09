# Plan 006: Persist MySQL error and slow query logs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- config/mysql/ compose.yml README.md manage.py .gitignore`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (disk growth if slow log is too verbose)
- **Depends on**: none
- **Category**: perf / dx
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

MySQL error logs currently live in the container filesystem and disappear across recreates. There is no slow query log, so multi-tenant “this site is slow” debugging stops at PHP slowlog. Mounting `runtime/logs/mysql` and enabling a conservative slow log gives stack-level visibility consistent with `runtime/logs/nginx` and `runtime/logs/php`.

## Current state

- PHP/Nginx logs: under `runtime/logs/...` and mounted in compose.
- MySQL: only data volume + backups mount; no log mount.
- `z-custom.cnf`: no `slow_query_log`, no `log_error` path override.
- `cmd_status` does not mention mysql log paths.

Layout convention from README:

```text
runtime/logs/                 # nginx/php logs
```

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compose | `docker compose config -q` | exit 0 |
| Dir | `ls runtime/logs/mysql` after create | directory exists |
| Live | files appear under runtime/logs/mysql when mysqld runs | error log non-empty after start |

## Scope

**In scope**:
- `config/mysql/conf.d/z-custom.cnf`
- `compose.yml` (volume mount)
- `README.md` / `docs/architecture.md` layout lines
- `.gitignore` if logs should be ignored (check existing patterns)
- Optional: `manage.py status` one-liner for log path
- `mkdir` guidance — prefer documenting; create `runtime/logs/mysql/.gitkeep` if repo uses gitkeeps elsewhere

**Out of scope**:
- Logrotate daemon container
- `log_queries_not_using_indexes = ON` (too noisy — leave OFF)
- Performance Schema consumers / sys schema dashboards

## Git workflow

- Branch: `advisor/006-mysql-logs`
- Commit: `add mysql error and slow logs`
- Do NOT push unless asked.

## Steps

### Step 1: Check gitignore for runtime logs

```bash
grep -n 'runtime\|logs' .gitignore || true
ls -la runtime/logs/
```

Match existing pattern: if `runtime/logs/**` is ignored, no need to gitignore mysql logs specially; if logs are committed via gitkeep, add `runtime/logs/mysql/.gitkeep` the same way as php/nginx.

### Step 2: Conf settings

Add to `[mysqld]` in `z-custom.cnf`:

```ini
log_error = /var/log/mysql/error.log

slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
log_queries_not_using_indexes = 0
```

Rationale: `long_query_time = 2` is conservative for PHP request budgets (`request_terminate_timeout = 60s` in pools). Operators can lower to `1` later.

### Step 3: Compose volume

Under `services.mysql.volumes` add:

```yaml
      - ./runtime/logs/mysql:/var/log/mysql
```

Ensure host directory exists in docs / quick start. On first start, mysqld must be able to create files — if permission errors occur, set ownership or use a command entrypoint fix. Official image runs as `mysql` user; bind-mount dir often needs `chmod 1777` or chown to the container mysql uid (typically 999). Prefer:

```bash
mkdir -p runtime/logs/mysql
chmod 777 runtime/logs/mysql   # pragmatic for bind mount; or document chown 999:999
```

If the repo avoids world-writable dirs, document:

```bash
sudo chown 999:999 runtime/logs/mysql
```

Do not commit secrets. Prefer a short README note over a complex init container.

### Step 4: Docs

Update layout trees in `README.md` and `docs/architecture.md`:

```text
runtime/logs/mysql/           # mysqld error + slow query logs
```

### Step 5: Optional status line

In `cmd_status` Quick checks:

```python
info(f"  mysql logs: vibeops/{rel(RUNTIME_DIR / 'logs' / 'mysql')}")
```

**Verify**:

```bash
grep -n 'slow_query_log\|log_error' config/mysql/conf.d/z-custom.cnf
grep -n 'logs/mysql' compose.yml README.md docs/architecture.md
docker compose config -q
```

Live:

```bash
mkdir -p runtime/logs/mysql
docker compose up -d mysql
# wait healthy
ls -la runtime/logs/mysql
```

→ `error.log` exists; after a slow query (optional), `slow.log` may appear when first slow query is logged.

## Test plan

- Restart mysql twice — error log on host persists and appends.
- `SELECT SLEEP(3);` as root (via safe helper if plan 003 done) → slow.log gains an entry when `long_query_time=2`.

## Done criteria

- [ ] error + slow logs configured under `/var/log/mysql/...`
- [ ] Host mount `runtime/logs/mysql` in compose
- [ ] Docs layout updated
- [ ] MySQL still becomes healthy with the mount
- [ ] `plans/README.md` 006 → DONE

## STOP conditions

- mysqld refuses to start due to permissions on `/var/log/mysql` after two fix attempts — report exact error; do not disable logging entirely without asking.
- Disk path conflicts with existing operator bind mounts — report.

## Maintenance notes

- Slow logs can grow; operators should truncate/rotate periodically (future logrotate plan).
- Reviewer: ensure `long_query_time` is not `0`; ensure indexes-not-used logging stays off.
- PHP slowlog remains per-user under `/home/<user>/logs` — complementary, not replaced.
