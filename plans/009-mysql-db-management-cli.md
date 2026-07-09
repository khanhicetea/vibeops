# Plan 009: Add manage.py db shell / list / create / user-reset

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- manage.py config/mysql/ README.md`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (user-reset changes passwords; create is idempotent-ish)
- **Depends on**: plans/003-mysql-safe-root-client.md, plans/007-mysql-credential-dx.md, plans/011-escape-mysql-grant-patterns.md
- **Category**: dx
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

MySQL lifecycle is only partially automated: `user create` makes accounts, `site create` optionally makes `{user}_{db}` databases. Day-2 ops (interactive shell, list databases, create another DB, rotate password) still require ad-hoc `docker compose exec` with root password. Extending the `db` command group (introduced or extended alongside plan 008) completes the multi-tenant DX.

## Current state

- Templates:
  - `config/mysql/templates/create-user.sql.template` — CREATE/ALTER USER + GRANT. After plan 011, it should use `__DB_GRANT_PATTERN__`, not raw `` `__USERNAME__\_%`.* ``.
  - `config/mysql/templates/create-database.sql.template` — CREATE DATABASE + GRANT. After plan 011, it should use the same escaped grant-pattern helper.
  - `config/mysql/templates/user-credentials.env.template` — credential file (plan 007 adds DB_*)
- `create_mysql_user` / site db creation in `manage.py`
- CLI has no top-level `db` group until plan 008; if 008 not merged, create the `db` subparser here and leave backup commands to 008 (or implement both in one branch if ordered 008→009).
- `DB_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")`
- Full DB name: `f"{username}_{db_name}"`

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `python3 -m py_compile manage.py` | exit 0 |
| Help | `./manage.py db --help` | lists shell/list/create/user-reset (+ backup if 008) |

## Scope

**In scope**:
- `manage.py` — commands:
  - `db shell` — interactive root or optional `--user` client
  - `db list` — list databases (optional filter `--user`)
  - `db create <username> <db_name>` — same as site path, without needing a domain
  - `db user-reset <username> [--password]` — rotate password, rewrite credentials file
- Reuse SQL templates and the escaped grant-pattern helper from plan 011; do not invent a parallel grant model
- README snippets
- Wizard menu items optional (nice-to-have)
- `plans/README.md` status

**Out of scope**:
- `db drop` / destructive user deletion (security footgun — skip unless you add double `--yes` and plan explicitly; **default: do not implement drop**)
- GUI admin tools
- Changing the privilege model away from `<username>_*` databases; the wildcard escaping fix from plan 011 is required and should be preserved
- Backup/restore (plan 008)

## Git workflow

- Branch: `advisor/009-mysql-db-management-cli`
- Commit: `add mysql db management commands`
- Do NOT push unless asked.

## Steps

### Step 1: Ensure safe root helper + credentials pattern

```bash
# No host argv root password
grep -nE 'f"-p\{root_password|-p\{root_password' manage.py || true
# Credentials no longer print password (007)
grep -n 'MySQL account:.*password\|info(f"MySQL account: {username} /' manage.py || true
```

If 003/007 missing, implement their relevant helpers/template first.

### Step 2: Shared helpers

Refactor if needed so site create and `db create` share one function:

```python
def ensure_mysql_database(username: str, db_name: str) -> str:
    """Create DB username_db_name and grant <username>_* privileges. Returns full name."""
    validate(username, USERNAME_RE, "username")
    validate(db_name, DB_NAME_RE, "db_name")
    db_full_name = f"{username}_{db_name}"
    sql = template_text(MYSQL_TEMPLATE_DIR / "create-database.sql.template", {
        "DB_FULL_NAME": db_full_name,
        "USERNAME": username,
        "DB_GRANT_PATTERN": mysql_user_database_grant_pattern(username),
    })
    mysql_root_exec_sql(sql)
    return db_full_name
```

Call this from `cmd_site_create` and `cmd_db_create`.

### Step 3: `db list`

```bash
./manage.py db list
./manage.py db list --user myuser
```

Implementation: run SQL

```sql
SHOW DATABASES;
```

Filter out system DBs. If `--user`, keep names starting with `{user}_`.

Print one name per line (script-friendly).

### Step 4: `db create`

```bash
./manage.py db create myuser app
```

→ creates `myuser_app` via template. Error if mysql down. Idempotent CREATE DATABASE IF NOT EXISTS already in template.

Does **not** require site/domain.

### Step 5: `db user-reset`

```bash
./manage.py db user-reset myuser
./manage.py db user-reset myuser --password '...'
```

Behavior:
- Generate password if not provided (`generate_password`)
- Reuse `create_mysql_user` logic or call it (it already CREATE/ALTER + write credentials)
- Prefer calling `create_mysql_user(username, password)` so ALTER USER path stays single-sourced
- Do not print password (007); print credentials path

### Step 6: `db shell`

```bash
./manage.py db shell                 # root via container env
./manage.py db shell --user myuser   # uses credentials file if present
```

Root shell must be interactive TTY:

```python
subprocess.run(
    ["docker", "compose", "exec", "mysql", "sh", "-lc", 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"'],
    cwd=str(ROOT),
    check=False,
)
```

Note: **no** `-T` for interactive shell (unlike SQL exec). Do not pass host password argv.

For `--user myuser`:
- Read `runtime/home/myuser/.credentials/mysql.env` via `parse_env_file`
- Connect as that user with password from file — prefer passing via container-side env without host argv, e.g. write a temporary defaults file inside container or:

```bash
docker compose exec -e MYSQL_PWD=... 
```

`MYSQL_PWD` on `docker compose exec -e` still exposes to docker API; acceptable if not on `ps` argv of host mysql client. Better: 

```bash
docker compose exec mysql sh -lc 'mysql -u"$U" -p"$P"' 
```

with env vars set only for the exec session via `docker compose exec -e U= -e P=` — still not perfect; minimum bar is **host process list does not show password as part of manage.py argv**. Using `docker compose exec -e MYSQL_PWD=password` means password is in manage.py’s argv to docker — **avoid**. 

Preferred for user shell:
1. Read password in Python
2. `docker compose exec -T mysql sh -lc 'mysql -uuser -p"$PASS"'` with `PASS` exported **inside** a script fed via env file mounted… simplest acceptable approach for this stack:

```python
# Write a temp defaults file on the host under runtime/ (mode 600), mount is already home —
# OR use mysql client from exec with stdin not password.

subprocess.run(
  ["docker", "compose", "exec", "-i", "mysql", "sh", "-lc",
   f'mysql -u{shlex.quote(user)} -p{shlex.quote(password)}'],
  ...
)
```

That still puts password in the string passed to docker. 

**Best practical approach for plan scope**: document that `db shell` is **root-only** for v1, and `db shell --user` is optional if you can pass password via Docker env without listing it in `ps` (Docker API still sees it). If user shell is hard to do cleanly, **implement root-only shell** and STOP user shell as follow-up — still mark plan DONE if root shell + list + create + user-reset work.

Minimum DONE set: **list, create, user-reset, root shell**.

### Step 7: Parser + README + optional wizard

Wire subcommands under `db`. If plan 008 already added `db`, extend the same subparser.

README:

```bash
./manage.py db list
./manage.py db create myuser app
./manage.py db user-reset myuser
./manage.py db shell
```

**Verify**:

```bash
python3 -m py_compile manage.py
./manage.py db --help
./manage.py db list --help
./manage.py db create --help
./manage.py db user-reset --help
./manage.py db shell --help
```

## Test plan

| Case | Expected |
|------|----------|
| list while mysql down | non-zero + clear error |
| create validates bad names | error via USERNAME_RE / DB_NAME_RE |
| user-reset rewrites mysql.env mode 600 | file updated, no stdout password |
| site create still creates DB | shared helper works |

## Done criteria

- [ ] `db list`, `db create`, `db user-reset`, `db shell` (root) implemented
- [ ] create-database / create-user templates reused
- [ ] No root password on host argv
- [ ] No user password printed on reset
- [ ] README updated
- [ ] `python3 -m py_compile manage.py` exits 0
- [ ] `plans/README.md` 009 → DONE

## STOP conditions

- Grant model change requested mid-flight — out of scope.
- Implementing `db drop --all` — refuse.
- Interactive shell cannot allocate TTY in executor environment — leave shell command implemented; note verification skipped for TTY.

## Maintenance notes

- Keep `cmd_site_create` on the shared `ensure_mysql_database` helper to avoid grant drift.
- Reviewer: username validation; credentials file modes; interaction with 008 parser tree.
- Future: `db drop database` with double confirm can be a separate plan.
