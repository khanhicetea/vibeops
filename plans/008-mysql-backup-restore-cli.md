# Plan 008: Add manage.py MySQL backup / restore / list-backups

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- manage.py compose.yml README.md config/mysql/`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW for backup; MED for restore (destructive)
- **Depends on**: plans/003-mysql-safe-root-client.md
- **Category**: stability / dx
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

Compose mounts `./runtime/backups/mysql:/backups` but nothing writes there. Without backup/restore in `manage.py`, the stack’s multi-tenant MySQL data has no first-class recovery path. Logical dumps via `mysqldump` match the DX of `user`/`site`/`cron` subcommands and unblock plan 010 (honest recovery docs).

## Current state

- Volume: `compose.yml` `runtime/backups/mysql:/backups`
- Orphan empty tree: repo-root `backups/mysql/` (prefer **only** `runtime/backups/mysql`; do not write to root `backups/`)
- No backup code in `manage.py`
- CLI pattern: nested subparsers (`user create`, `cron create`, …) in `build_parser()`
- After plan 003: root SQL should use container env password, not host argv

**Naming conventions**: databases are `{username}_{db_name}`; users grant on `` `{username}\_%`.* ``.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `python3 -m py_compile manage.py` | exit 0 |
| Help | `./manage.py db --help` / `backup --help` | shows subcommands |
| Compose | `docker compose config -q` | exit 0 |

## Scope

**In scope**:
- `manage.py` — `db backup`, `db restore`, `db list-backups` (names may be `db backups` list; pick one consistent set)
- `README.md` — backup/restore section
- Optional tiny retention helper (keep last N files)
- `plans/README.md` status

**Out of scope**:
- Percona XtraBackup / physical hot backup
- Automated cron schedule service (mention how to add a host cron or supercronic job calling manage.py — do not require a new compose service)
- Encrypting dumps at rest
- Restoring to a remote server
- Deleting the unused root `backups/` directory (optional cleanup only if empty and operator-safe; not required)

## Git workflow

- Branch: `advisor/008-mysql-backup-restore`
- Commit: `add mysql backup restore commands`
- Do NOT push unless asked.

## Steps

### Step 1: Prerequisites — plan 003 helper

Confirm a root exec helper exists that does **not** put the password on host argv:

```bash
grep -n 'mysql_root_exec\|MYSQL_ROOT_PASSWORD' manage.py | head -40
grep -nE 'f"-p\{root|-p\{root_password' manage.py || true
```

→ Helper present; no host argv password. If missing, implement plan 003 first (or inline the same pattern once as a shared helper).

Add a dump-oriented helper:

```python
BACKUP_DIR = RUNTIME_DIR / "backups" / "mysql"

def mysql_root_dump(args: list[str], *, output_path: Path) -> None:
    """Run mysqldump inside the mysql container; write stdout to host path.

    args: extra mysqldump arguments after authentication, e.g.
    ["--single-transaction", "--routines", "--databases", "foo"]
    """
```

Implementation sketch (executor may refine):

```python
def mysql_root_dump(mysqldump_args: list[str], *, output_path: Path) -> None:
    mkdir(BACKUP_DIR, 0o700)
    cmd = [
        "docker", "compose", "exec", "-T", "mysql",
        "sh", "-lc",
        'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" ' + " ".join(shlex.quote(a) for a in mysqldump_args),
    ]
    # Stream to host file — use subprocess with stdout=file
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as fh:
        cp = subprocess.run(cmd, cwd=str(ROOT), stdout=fh, stderr=subprocess.PIPE, text=True)
    if cp.returncode != 0:
        die(f"mysqldump failed: {cp.stderr}")
```

Prefer writing to the **host** path `runtime/backups/mysql/...` (compose cwd-relative). Alternatively write to `/backups/...` **inside** the container (same bind mount). Inside-container path is simpler for permissions:

```python
container_path = f"/backups/{filename}"
# mysqldump ... > /backups/file.sql inside sh -lc
# host: BACKUP_DIR / filename
```

Use `--single-transaction` for InnoDB consistency without global lock when possible. Include `--routines --triggers --events` for app completeness. Default charset utf8mb4.

### Step 2: `db backup` command

CLI:

```bash
./manage.py db backup                 # all non-system databases
./manage.py db backup myuser_app      # one database
./manage.py db backup --user myuser   # all DBs matching myuser\_%
```

Filename pattern:

```text
runtime/backups/mysql/YYYYMMDD-HHMMSS_all.sql
runtime/backups/mysql/YYYYMMDD-HHMMSS_myuser_app.sql
```

Skip system schemas: `mysql`, `sys`, `performance_schema`, `information_schema`.

For “all” dumps, either:
- one file with multiple `--databases`, or
- one file per database

Prefer **one file per database** for restore DX, plus optional `--combined` if easy. Minimum viable: single-database backup + “all user databases as separate files in one run”.

Print host-relative paths only; never print root password.

### Step 3: `db list-backups` command

```bash
./manage.py db list-backups
```

List files in `runtime/backups/mysql` with size and mtime, sorted newest first. Empty dir → friendly message.

### Step 4: `db restore` command

```bash
./manage.py db restore runtime/backups/mysql/YYYYMMDD-HHMMSS_myuser_app.sql
./manage.py db restore YYYYMMDD-HHMMSS_myuser_app.sql   # resolve under BACKUP_DIR
```

Safety:
- Require `--yes` flag to proceed (or interactive confirm if stdin is TTY and no `--yes`)
- Restore via:

```bash
docker compose exec -T mysql sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"' < file.sql
```

or pipe file content as `input_text` / stdin from host file read.

- Warn that restore can overwrite objects in the dump
- Do not auto-drop unrelated databases

### Step 5: Optional retention

```bash
./manage.py db backup --keep 7
```

After successful backup, delete older backup files beyond N (count per naming prefix or global). If complex, skip and document manual `find` cleanup — retention is nice-to-have, not required for DONE.

### Step 6: Wire parser + README

In `build_parser()`:

```python
    db = sub.add_parser("db", help="Manage MySQL databases and backups")
    db_sub = db.add_subparsers(dest="db_command", required=True)
    # backup, restore, list-backups (and leave room for plan 009 commands)
```

README section:

```markdown
## MySQL backups

Backups write to `runtime/backups/mysql` (mounted at `/backups` in the mysql container).

./manage.py db backup
./manage.py db backup myuser_app
./manage.py db list-backups
./manage.py db restore runtime/backups/mysql/<file>.sql --yes
```

**Verify**:

```bash
python3 -m py_compile manage.py
./manage.py db --help
./manage.py db backup --help
./manage.py db restore --help
./manage.py db list-backups --help
```

→ exit 0; help text sensible.

Live (when mysql running with at least one DB):

```bash
./manage.py db backup
./manage.py db list-backups
ls -la runtime/backups/mysql
```

→ at least one `.sql` file, non-trivial size.

Restore test: only on disposable DB — create empty test DB, backup, drop table, restore — **do not** run destructive restore against operator production without consent. If no safe DB, skip live restore and note it.

## Test plan

| Case | Expected |
|------|----------|
| backup while mysql stopped | clear error, exit non-zero |
| list-backups empty | message, exit 0 |
| backup one DB | file created under runtime/backups/mysql |
| restore without --yes | aborted |
| password on host ps | not present (003) |

No formal unit test harness — add none unless you introduce a tiny pure function for filename formatting worth testing with `python3 -c`.

## Done criteria

- [ ] `db backup`, `db restore`, `db list-backups` work from `./manage.py`
- [ ] Files land in `runtime/backups/mysql`
- [ ] Root password not on host argv
- [ ] Restore gated by `--yes` or interactive confirm
- [ ] README documents commands
- [ ] `python3 -m py_compile manage.py` exits 0
- [ ] `plans/README.md` 008 → DONE

## STOP conditions

- Plan 003 not done and you cannot avoid password-on-argv — implement 003 first.
- `mysqldump` missing in image (should exist in `mysql:8.4`) — STOP and report image contents.
- Disk full / permission denied on bind mount — report; do not silently write to `/tmp` only.
- Restore design would require dropping all tenants by default — STOP; scope is per-dump apply only.

## Maintenance notes

- Plan 009 adds more `db` subcommands — share parser tree; do not create a second top-level command.
- Plan 010 documents that these logical dumps are the recovery path while binlog is off.
- Reviewer: check shlex quoting; check system DBs excluded; check mode on backup dir.
- Future: gzip (`.sql.gz`) is a good follow-up; not required now unless trivial (`gzip` in container).
