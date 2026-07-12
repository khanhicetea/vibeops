# Plan 004: Managed schedule for logical MySQL backups

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- bento/commands/db_commands.py bento/commands/parser.py bento/commands/cron_commands.py bento/services/cron_runtime.py docker/php/ compose.yml README.md docs/architecture.md`
> On mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (must not double-run backups or store secrets in crontab)
- **Depends on**: none
- **Category**: direction / dx / reliability
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

Logical backup/restore is solid (`db backup` with atomic promote, gzip, retention), but the README recovery path still says operators must schedule host cron themselves. That is the step that gets skipped. A managed schedule — preferably as a stack-level supercronic job or a generated host crontab snippet — closes the DR loop without inventing a new backup engine.

## Current state

- Backup implementation: `bento/commands/db_commands.py` (`cmd_db_backup`) writes under `runtime/backups/<mysql_service>/`
- README: “Schedule regular `./manage.py db backup` (host cron or manual…)”
- Cron system today is **app-scoped** (`crons` in state, runs as app user via `php-cron-as`) — **root/stack backups cannot safely run as an app user**
- Stack already has always-present daily maintenance jobs in supercronic (see `docs/architecture.md` cron layout) for logrotate — pattern for “version-level system jobs”

## Design choice (do this, not a PaaS)

**Preferred approach (pick in implementation, document in README):**

### Option A — Host crontab generator (simplest, recommended for v1)

```bash
./manage.py db schedule install \
  --cron '15 3 * * *' \
  --gzip \
  --keep 14 \
  --mysql-service mysql84
```

- Writes a root-owned file under `runtime/generated/cron/host/bento-db-backup.cron` **or** prints install instructions
- Content runs on the **host**: `cd <repo> && ./manage.py db backup --gzip --keep 14 --mysql-service mysql84`
- Also support `./manage.py db schedule show` and `db schedule uninstall` (remove generated file + tell user to remove crontab line)
- Optional: `db schedule install --user-crontab` that runs `crontab -l` merge — **only if** you can do it safely; otherwise write file + print `crontab` install one-liner and do not auto-mutate user crontab

### Option B — Stack system job inside a small `backup` profile container

Only if Option A is blocked on platform assumptions. Do **not** overload `php*-cron` app jobs for root MySQL dumps.

**This plan mandates Option A** unless docker-only hosts without host cron are the primary target — then STOP and report for product decision.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Gate | `make check` | exit 0 |
| Help | `./manage.py db schedule --help` | subcommands listed |

## Scope

**In scope**:
- `bento/commands/db_commands.py` — schedule install/show/uninstall (+ maybe list)
- `bento/commands/parser.py` — `db schedule` subcommands
- `bento/utils/paths.py` — path constant for generated schedule file if needed
- `tests/test_db_backup_schedule.py` — new
- `README.md` recovery section update (replace “use host cron manually” with managed command)
- `.env.example` optional defaults: `DB_BACKUP_CRON`, `DB_BACKUP_KEEP`

**Out of scope**:
- Off-box S3 upload (document as follow-up: user wraps command)
- Binlog / PITR
- Changing atomic backup file format
- App-scoped backup schedules (whole service dump is enough for v1)

## Git workflow

- Branch: `advisor/004-db-backup-schedule`
- Commit style: e.g. `db backup schedule`
- Do not push unless asked

## Product behavior

```text
./manage.py db schedule show
./manage.py db schedule install [--cron '15 3 * * *'] [--gzip] [--keep N] [--mysql-service mysql84]
./manage.py db schedule uninstall
```

- Defaults: cron `15 3 * * *`, `--gzip` on, `--keep 14`, service `DEFAULT_MYSQL_SERVICE`
- Generated job must use absolute path to `manage.py` resolved from repo root (`paths.ROOT`)
- Never embed MySQL passwords in the crontab line (backups already use root option files from render)
- `install` is idempotent (rewrite same file)
- Multi-service: allow repeated `--mysql-service` or install multiple lines; simplest v1 = one service per install invocation, file can hold multiple lines keyed by service

## Steps

### Step 1: Unit tests for crontab line rendering

Pure functions: given root, service, keep, gzip → expected shell line. No docker.

### Step 2: Implement schedule commands

Write file under e.g. `runtime/generated/cron/host/db-backup.crontab` with header comment “managed by bento; do not edit”.

Print after install:

```text
Install on host with:
  (crontab -l 2>/dev/null; cat runtime/generated/cron/host/db-backup.crontab) | crontab -
```

(or document systemd timer alternative in README only)

### Step 3: Parser + README

Wire subcommands; update recovery docs.

### Step 4: Gate

`make check`

## Test plan

- Rendered crontab contains `manage.py db backup` and `--keep`
- uninstall removes generated file
- invalid `--keep 0` rejected (backup command already rejects keep 0 — reuse validation)

## Done criteria

- [ ] `db schedule install|show|uninstall` exist
- [ ] Generated schedule does not contain passwords
- [ ] README recovery path points at `db schedule`
- [ ] `make check` passes
- [ ] `plans/README.md` → DONE

## STOP conditions

- Implementing backup inside app supercronic as root via `php-cron-as` (security smell) — stop
- Auto-editing user crontab without a dry-run/print path on failure — prefer file + instructions only

## Maintenance notes

- Off-box copy remains operator responsibility; future plan can add `db backup --hook` 
- Reviewers: ensure schedule uses same retention semantics as `cmd_db_backup`
