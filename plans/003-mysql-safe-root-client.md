# Plan 003: Stop passing MySQL root password on process argv

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- manage.py`
> Compare live `create_mysql_user` / site DB creation against Current state.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (required by 008, 009)
- **Category**: security
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

`manage.py` runs MySQL as root with `-p{root_password}` on the **host-visible** command line. The password appears in `ps`, shell history adjacent tooling, and crash reports. The MySQL container already has `MYSQL_ROOT_PASSWORD` in its environment from Compose. Routing all root SQL through `docker compose exec` + **container env** removes the secret from host argv and gives later backup/db commands a single helper to reuse.

## Current state

`manage.py` call sites (approx lines 372–396 and 535–541):

```python
run(["docker", "compose", "exec", "-T", "mysql", "mysql", "-uroot", f"-p{root_password}"], input_text=sql)
```

Used by:
- `create_mysql_user`
- `cmd_site_create` database creation

Root password is loaded via `stack_env().get("MYSQL_ROOT_PASSWORD")` mainly to decide whether to skip.

**Conventions**: pure Python, no third-party deps; `run()` wrapper at ~line 218; `die`/`info`/`warn` helpers; `StackError` for user-facing failures.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `python3 -m py_compile manage.py` | exit 0 |
| Grep leak | `grep -n 'f"-p{root` manage.py; grep -n "\-p{root" manage.py` | no matches |
| Help | `./manage.py --help` | exit 0 |

## Scope

**In scope**:
- `manage.py` only (helper + call sites that pass root password on argv)
- `plans/README.md` status

**Out of scope**:
- Changing SQL templates
- Printing or not printing **user** passwords (plan 007)
- Backup commands (plan 008) — but design the helper so 008 can call it
- Committing any password file into git

## Git workflow

- Branch: `advisor/003-mysql-safe-root-client`
- Commit: `fix mysql root password argv`
- Do NOT push unless asked.

## Steps

### Step 1: Add `mysql_root_cli` / `mysql_root_exec` helpers

Near other MySQL helpers (`mysql_string_literal`, ~line 210), add helpers that **never** put the password on the host argv list.

Recommended design:

```python
def mysql_service_ready() -> bool:
    return (ROOT / ".env").exists() and service_running("mysql")


def mysql_root_exec_sql(sql: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run SQL as MySQL root inside the container using container env password.

    Relies on MYSQL_ROOT_PASSWORD already injected by compose into the mysql service.
    Does not pass the password on the host process command line.
    """
    if not service_running("mysql"):
        die("mysql service is not running")
    # -p"$MYSQL_ROOT_PASSWORD" expands inside the container shell only.
    return run(
        [
            "docker", "compose", "exec", "-T", "mysql",
            "sh", "-lc",
            'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"',
        ],
        input_text=sql,
        check=check,
        capture=True,
    )
```

Notes for the executor:
- Prefer `capture=True` so stderr from mysql can be shown on failure without dumping secrets (mysql may print password warnings about using password on CLI **inside** the container — acceptable vs host argv).
- On failure, re-raise or `die` with returncode and stderr **after redacting** any accidental password echo (simple: do not print full command with env).
- Keep a lightweight check that `MYSQL_ROOT_PASSWORD` is set in host `.env` via `stack_env()` for skip/early messaging where create_mysql_user currently skips — still **do not** pass that value into `run([...])` argv.

Optional quieter client flags (allowed):

```text
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --batch --raw --silent
```

For multi-statement SQL templates that need result display, avoid `--silent` on interactive future shell (plan 009).

### Step 2: Replace create_mysql_user exec

In `create_mysql_user`:
- Keep skip logic when `.env` missing, mysql not running, or host env lacks `MYSQL_ROOT_PASSWORD` (compose cannot start without it, but message stays useful).
- Replace the `run([..., f"-p{root_password}"], input_text=sql)` with `mysql_root_exec_sql(sql)`.

### Step 3: Replace site database creation exec

In `cmd_site_create` where it builds `create-database.sql.template` SQL, use `mysql_root_exec_sql(sql)` instead of inlined `run` with `-p{root_password}`.

### Step 4: Grep for remaining host-side password argv

```bash
grep -nE 'mysql.*-p\{|f"-p\{|f'\''-p\{|-p\{root' manage.py || true
grep -n 'MYSQL_ROOT_PASSWORD' manage.py
```

→ No `f"-p{root_password}"` (or equivalent) in `run([...])` argv lists. Mentions of `MYSQL_ROOT_PASSWORD` for env checks / docs are fine.

**Verify**:

```bash
python3 -m py_compile manage.py
./manage.py --help
```

→ exit 0

## Test plan

When mysql is running and `.env` is valid (operator environment):

```bash
# Dry logic: create is destructive; prefer a harmless SQL via a temporary call if you add a dev-only path.
# Minimum: re-run an existing user create against an existing user should ALTER USER (idempotent templates).
```

Do **not** put real passwords into the plan report. Confirm with:

```bash
# While a manage.py mysql operation runs (if available), on the host:
# ps aux | grep mysql | grep -v grep
# Host process list must not show the root password string.
```

If you cannot run live mysql, static grep gates + py_compile are sufficient; note "live ps check skipped" in completion.

## Done criteria

- [ ] Helper exists and is used by both existing root SQL call sites
- [ ] No host argv contains the root password for mysql client
- [ ] Skip messages when mysql down / missing env still work
- [ ] `python3 -m py_compile manage.py` exits 0
- [ ] `plans/README.md` 003 → DONE

## STOP conditions

- Official image stops exporting `MYSQL_ROOT_PASSWORD` into the running container (unlikely) — then use a generated defaults-extra-file **inside** the container via `sh -lc` heredoc without host argv, or STOP and report.
- Another branch already refactored mysql exec — merge carefully; do not duplicate helpers.
- You feel you must write the password into a committed file — STOP (never commit secrets).

## Maintenance notes

- Plans 008/009 **must** call this helper (or an extension like `mysql_root_exec_argv([...])` for mysqldump).
- Reviewer: ensure `capture=True` does not accidentally `info(sql)` that includes passwords from templates (user password SQL is separate; root password should not appear in SQL text).
- Inside-container `-p"$MYSQL_ROOT_PASSWORD"` still shows in **container** `ps` briefly; that is acceptable for this plan. Future hardening: defaults-extra-file with 600 perms in a tmpfs — optional follow-up, not required.
