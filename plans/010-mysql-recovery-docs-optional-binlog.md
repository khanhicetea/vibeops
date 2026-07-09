# Plan 010: Document MySQL recovery model; optional binlog profile

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- config/mysql/ compose.yml README.md docs/ manage.py`

## Status

- **Priority**: P3
- **Effort**: S (docs-only) or M (if implementing optional binlog profile)
- **Risk**: MED if binlog enabled without disk/ops plan; LOW for docs-only
- **Depends on**: plans/008-mysql-backup-restore-cli.md
- **Category**: docs / stability
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

`disable_log_bin` is a deliberate single-node choice (less I/O/disk), but operators may assume point-in-time recovery (PITR) exists. Combined with a silent lack of backups (fixed in 008), this is a false sense of safety. This plan makes the recovery model **explicit**: default = InnoDB crash recovery + logical dumps; optional binlog profile only after backups exist.

## Current state

`config/mysql/conf.d/z-custom.cnf`:

```ini
disable_log_bin
```

No README section describing:
- What survives a container recreate (named volume `mysql-data`)
- What survives accidental `DROP` / bad migration (only if dumps exist)
- That binlog is off by default

Plan 008 adds `./manage.py db backup|restore|list-backups` writing to `runtime/backups/mysql`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Grep docs | `grep -n 'binlog\|backup\|recover' README.md docs/` | new section present |
| Compose | `docker compose config -q` | exit 0 if conf profiles added |

## Scope

**In scope (required)**:
- `README.md` — “MySQL data & recovery” section
- `docs/architecture.md` — short recovery note
- Confirm default remains `disable_log_bin` unless operator opts in

**In scope (optional, implement only if 008 is DONE and you have bandwidth)**:
- `config/mysql/conf.d/z-binlog.cnf.example` or Compose profile `mysql-binlog` that **removes** `disable_log_bin` and sets safe defaults:
  - `server-id = 1`
  - `binlog_expire_logs_seconds = 604800` (7d) or similar
  - `binlog_format = ROW`
- Document that PITR still needs dumps + binlogs + operator skill; not a managed RDS substitute

**Out of scope**:
- Real replicas / multi-primary
- Automated binlog shipping to S3
- Replacing logical dumps with only binlogs
- Turning binlog **on by default**

## Git workflow

- Branch: `advisor/010-mysql-recovery-docs`
- Commit: `docs mysql recovery model` (and `optional mysql binlog profile` if applicable)
- Do NOT push unless asked.

## Steps

### Step 1: Verify backups exist in the product

```bash
./manage.py db backup --help
```

→ Works (008). If not, **STOP** and finish 008 first. Do not enable binlog as a substitute for backups.

### Step 2: Write recovery documentation (required)

Add to `README.md` (after MySQL backups section from 008, or combined):

```markdown
## MySQL data and recovery

### What is durable by default

- Table data lives in the Docker named volume `mysql-data` (see `compose.yml`).
- Recreating the `mysql` container keeps data **if** the volume is not removed.
- `docker compose down -v` **destroys** MySQL data. Do not use `-v` on production hosts unless you intend to wipe.

### What is not covered without backups

- Accidental `DROP DATABASE` / bad app migration / logical corruption
- With `disable_log_bin` (default), there is **no** point-in-time recovery from the binary log

### Recommended recovery path

1. Schedule regular `./manage.py db backup` (host cron or manual before risky deploys)
2. Store/copy `runtime/backups/mysql` off-box if the host disk is not enough
3. Restore with `./manage.py db restore <file.sql> --yes`

### Crash vs human error

| Event | Default protection |
|-------|--------------------|
| Container crash / reboot | InnoDB recovery on `mysql-data` volume |
| `docker compose up -d` recreate | Volume keeps data |
| `docker compose down -v` | **Data loss** |
| Accidental DROP / bad migration | Logical dump restore only |
| PITR to minute X | Not available while binlog disabled |
```

Mirror a shorter paragraph in `docs/architecture.md`.

### Step 3: Keep default binlog disabled

Confirm `z-custom.cnf` still has `disable_log_bin` for the default path. Do **not** remove it as part of “docs only”.

**Verify**:

```bash
grep -n 'disable_log_bin' config/mysql/conf.d/z-custom.cnf
grep -n 'point-in-time\|disable_log_bin\|mysql-data' README.md
```

→ Default still disables binlog; README states recovery model.

### Step 4 (optional): Example binlog overlay

If implementing optional profile:

1. Create `config/mysql/conf.d/z-binlog.cnf.example`:

```ini
# Copy to z-binlog.cnf and remove disable_log_bin from z-custom.cnf
# or mount this file and ensure disable_log_bin is not active.
# Enabling binlog increases disk I/O and requires monitoring free space.

[mysqld]
server-id = 1
log_bin = /var/lib/mysql/mysql-bin
binlog_format = ROW
binlog_expire_logs_seconds = 604800
# sync_binlog = 1          # durability; more I/O
# innodb_flush_log_at_trx_commit = 1  # already default
```

2. Document **manual** enable steps in README — do not auto-enable:
   - Take a dump first (`db backup`)
   - Remove or comment `disable_log_bin` in `z-custom.cnf`
   - Add binlog settings
   - `docker compose up -d mysql`
   - Monitor disk under the data volume

3. Explicit warning: binlog without off-box dumps is still not a backup strategy.

**Do not** commit a live `z-binlog.cnf` that conflicts with `disable_log_bin` unless compose is structured so only one applies. Prefer `.example` + docs to avoid footguns.

### Step 5: Cross-link plans in docs language

Use operator language, not “plan 008”:

```text
use manage.py db backup / restore
```

**Verify**:

```bash
grep -n 'db backup\|recovery\|binlog' README.md docs/architecture.md
python3 -m py_compile manage.py   # if untouched, still fine
```

## Test plan

- Docs-only: review checklist — a new operator can answer “what happens if I down -v?” and “how do I recover a dropped DB?” from README alone.
- If binlog example added: do **not** enable on a production volume in CI without intent; static file review only unless operator requests a live toggle on a disposable volume.

## Done criteria

- [ ] README documents volume durability, `down -v` risk, and no PITR with default config
- [ ] README points at `db backup` / `db restore` as human-error recovery
- [ ] Default `disable_log_bin` remains in effect for stock compose
- [ ] If optional binlog example exists, it is opt-in and documented with disk/ops warnings
- [ ] `plans/README.md` 010 → DONE

## STOP conditions

- Temptation to enable binlog by default “for production” without disk budget — stop; leave default off.
- 008 not available — stop; docs that invent non-existent commands are worse than silence.
- Changing replication topology — out of scope.

## Maintenance notes

- When operators enable binlog, revisit backup retention + disk alerts.
- Reviewer: ensure docs do not claim PITR works out of the box.
- Future: off-site sync of `runtime/backups/mysql` can be a separate ops plan (rclone/restic) outside this repo if desired.
