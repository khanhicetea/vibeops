# Plan 011: Escape MySQL database grant patterns for usernames

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- manage.py config/mysql/templates README.md plans/009-mysql-db-management-cli.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none; execute before `plans/009-mysql-db-management-cli.md` if that plan has not landed yet
- **Category**: security / correctness / dx
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

VibeOps creates one MySQL user per Linux/PHP user and grants access to databases named `<username>_<db_name>`. The current templates grant on `` `__USERNAME__\_%`.* ``. That correctly escapes the separator underscore, but it does **not** escape underscores that are part of the username itself, so a username like `foo_bar` can produce a grant pattern that also matches `fooXbar_*`. This is a tenant isolation correctness issue and a confusing DX trap for valid usernames.

## Current state

Relevant files:

- `manage.py` — validates usernames/db names and renders SQL templates.
- `config/mysql/templates/create-user.sql.template` — creates/updates a MySQL account and grants database privileges.
- `config/mysql/templates/create-database.sql.template` — creates one database and re-grants the user pattern.
- `plans/009-mysql-db-management-cli.md` — future DB-management plan that should reuse the corrected grant helper if still TODO.

Current validation permits underscores in usernames and database suffixes:

```python
# manage.py:41-45
USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
DOMAIN_RE = re.compile(r"^[A-Za-z0-9.-]+$")
DOMAIN_PATH_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PHP_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+$")
DB_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")
```

Current template renderer uses simple placeholder replacement:

```python
# manage.py:194-202
def render_template_text(text: str, values: dict[str, Any]) -> str:
    for key, value in values.items():
        text = text.replace(f"__{key}__", str(value))
    return text


def template_text(path: Path, values: dict[str, Any]) -> str:
```

Current user creation renders only `USERNAME` and `MYSQL_PASSWORD_SQL` into the grant template:

```python
# manage.py:391-395
sql = template_text(MYSQL_TEMPLATE_DIR / "create-user.sql.template", {
    "USERNAME": username,
    "MYSQL_PASSWORD_SQL": mysql_string_literal(password),
})
```

Current database creation renders only `DB_FULL_NAME` and `USERNAME`:

```python
# manage.py:533-541
db_full_name = f"{username}_{db_name}"
# ...
sql = template_text(MYSQL_TEMPLATE_DIR / "create-database.sql.template", {
    "DB_FULL_NAME": db_full_name,
    "USERNAME": username,
})
```

Current SQL templates:

```sql
-- config/mysql/templates/create-user.sql.template:1-4
CREATE USER IF NOT EXISTS '__USERNAME__'@'%' IDENTIFIED BY '__MYSQL_PASSWORD_SQL__';
ALTER USER '__USERNAME__'@'%' IDENTIFIED BY '__MYSQL_PASSWORD_SQL__';
GRANT ALL PRIVILEGES ON `__USERNAME__\_%`.* TO '__USERNAME__'@'%';
FLUSH PRIVILEGES;

-- config/mysql/templates/create-database.sql.template:1-3
CREATE DATABASE IF NOT EXISTS `__DB_FULL_NAME__` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `__USERNAME__\_%`.* TO '__USERNAME__'@'%';
FLUSH PRIVILEGES;
```

Repo conventions to match:

- Keep SQL templates under `config/mysql/templates/` and render them through `template_text()` / `write_template()`.
- Keep helper functions near existing MySQL string helpers (`mysql_string_literal` at `manage.py:210`).
- Verification baseline from `plans/README.md`: `python3 -m py_compile manage.py`; this repo currently has no unit test suite.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Drift check | `git diff --stat 7ed5180..HEAD -- manage.py config/mysql/templates README.md plans/009-mysql-db-management-cli.md` | no unexpected drift, or excerpts reconciled |
| Python syntax | `python3 -m py_compile manage.py` | exit 0 |
| Helper behavior | `python3 - <<'PY' ... PY` from Step 3 | prints `ok` |
| Template check | `grep -R "__USERNAME__\\\\_%" config/mysql/templates || true` | no matches after change |
| CLI help | `./manage.py --help` | exit 0 |

## Scope

**In scope**:

- `manage.py`
- `config/mysql/templates/create-user.sql.template`
- `config/mysql/templates/create-database.sql.template`
- `README.md` only if you add a short note about escaped grant patterns; optional
- `plans/009-mysql-db-management-cli.md` only if it still says not to change/reuse the old grant pattern; update it to refer to the new helper so future execution does not regress this fix
- `plans/README.md` status row

**Out of scope**:

- Changing username or database naming rules.
- Changing the privilege model away from `<username>_*` databases.
- Adding per-user `MAX_USER_CONNECTIONS` or quotas.
- Reworking backup/restore, shell, or DB-management commands beyond keeping plan 009 consistent.
- Exposing MySQL outside the Compose backend network.

## Git workflow

- Branch: `advisor/011-escape-mysql-grants`
- Commit message: `escape mysql grant patterns`
- Do NOT push unless the operator explicitly asks.

## Steps

### Step 1: Confirm the current grant templates and call sites

Run:

```bash
grep -n "GRANT\|template_text(MYSQL_TEMPLATE_DIR" manage.py config/mysql/templates/*.template
```

Expected: both SQL templates contain `` `__USERNAME__\_%`.* `` and `manage.py` renders those templates from `create_mysql_user()` and `cmd_site_create()`.

If the templates already use a `DB_GRANT_PATTERN` placeholder and `manage.py` already computes an escaped pattern, skip to Step 3 and only run verification.

### Step 2: Add a grant-pattern helper in `manage.py`

Near the existing `mysql_string_literal()` helper, add helpers with this behavior:

```python
def mysql_grant_pattern(value: str) -> str:
    """Escape MySQL GRANT database-pattern wildcards for a literal identifier fragment."""
    return value.replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%")


def mysql_user_database_grant_pattern(username: str) -> str:
    """Return the database pattern for all databases owned by username: <username>_*.

    In MySQL GRANT database patterns, `_` and `%` are wildcards even inside the
    database pattern. Escape username wildcards and append an escaped separator
    underscore so `foo_bar` grants `foo_bar_*`, not `fooXbar_*`.
    """
    return mysql_grant_pattern(username) + r"\_%"
```

The exact names may differ, but the behavior must match these examples:

- `mysql_user_database_grant_pattern("app") == r"app\_%"`
- `mysql_user_database_grant_pattern("foo_bar") == r"foo\_bar\_%"`
- `mysql_user_database_grant_pattern("foo-bar") == r"foo-bar\_%"`

Do not use `mysql_string_literal()` for this. That helper is for SQL string literals; this new helper is for MySQL database grant patterns inside backticks.

**Verify**:

```bash
python3 -m py_compile manage.py
```

Expected: exit 0.

### Step 3: Pass the escaped pattern into both SQL templates

Update `create_mysql_user()` so the values dict includes the new placeholder, for example:

```python
"DB_GRANT_PATTERN": mysql_user_database_grant_pattern(username),
```

Update the database-creation path in `cmd_site_create()` the same way.

Update both templates from the username-derived inline pattern to the explicit placeholder:

```sql
GRANT ALL PRIVILEGES ON `__DB_GRANT_PATTERN__`.* TO '__USERNAME__'@'%';
```

**Verify helper and template rendering**:

```bash
python3 - <<'PY'
import manage

assert manage.mysql_user_database_grant_pattern("app") == r"app\_%"
assert manage.mysql_user_database_grant_pattern("foo_bar") == r"foo\_bar\_%"
assert manage.mysql_user_database_grant_pattern("foo-bar") == r"foo-bar\_%"

sql = manage.template_text(manage.MYSQL_TEMPLATE_DIR / "create-user.sql.template", {
    "USERNAME": "foo_bar",
    "MYSQL_PASSWORD_SQL": "dummy",
    "DB_GRANT_PATTERN": manage.mysql_user_database_grant_pattern("foo_bar"),
})
assert "`foo\\_bar\\_%`.*" in sql, sql
assert "`foo_bar\\_%`.*" not in sql, sql
print("ok")
PY
```

Expected: prints `ok` and exits 0.

Then run:

```bash
grep -R "__USERNAME__\\\\_%" config/mysql/templates || true
```

Expected: no output.

### Step 4: Keep future DB-management plan consistent if it is still TODO

Open `plans/009-mysql-db-management-cli.md`. If it still instructs an executor to preserve/reuse the old grant pattern literally, update only those plan lines so they say:

- Reuse `mysql_user_database_grant_pattern(username)` or whatever helper name you chose.
- Do not reintroduce raw `` `__USERNAME__\_%`.* `` grants.

If plan 009 is already DONE or no longer exists, do not edit it; report that in your completion note.

**Verify**:

```bash
grep -R "__USERNAME__\\\\_%\|username_%\|username\\\\_%" plans/009-mysql-db-management-cli.md || true
```

Expected: no stale instruction requiring the old raw pattern. Mentions in historical/current-state context are acceptable only if they explicitly say it was the old behavior and must not be reintroduced.

### Step 5: Optional README note

If README has a MySQL user/database section that describes grants, add one short sentence:

> MySQL grants escape wildcard characters in usernames before granting access to `<username>_*` databases, so valid usernames containing `_` do not broaden privileges.

Do not add a long MySQL tutorial.

**Verify**:

```bash
./manage.py --help >/dev/null
python3 -m py_compile manage.py
```

Expected: both exit 0.

## Test plan

This repo does not currently have a unit test suite. Use executable Python assertions as a regression check:

```bash
python3 - <<'PY'
import manage
cases = {
    "app": r"app\_%",
    "foo_bar": r"foo\_bar\_%",
    "foo-bar": r"foo-bar\_%",
    "a_b_c": r"a\_b\_c\_%",
}
for username, expected in cases.items():
    actual = manage.mysql_user_database_grant_pattern(username)
    assert actual == expected, (username, actual, expected)
print("ok")
PY
```

Expected: prints `ok`.

If a test framework is added before executing this plan, create a small unit test for this helper instead of relying only on the inline assertion.

## Done criteria

All must be true:

- [ ] `python3 -m py_compile manage.py` exits 0.
- [ ] The helper assertion command in Step 3 prints `ok`.
- [ ] Both MySQL SQL templates use `__DB_GRANT_PATTERN__` for the database grant.
- [ ] No SQL template contains raw `` `__USERNAME__\_%`.* ``.
- [ ] A username containing `_` renders a grant pattern with the username underscore escaped, e.g. `foo\_bar\_%`.
- [ ] Plan 009, if still TODO, no longer instructs a future executor to preserve the old raw grant pattern.
- [ ] `plans/README.md` status row for plan 011 is updated.

## STOP conditions

Stop and report back if:

- `manage.py` no longer renders SQL through `template_text()` / `MYSQL_TEMPLATE_DIR`; the code has drifted enough that this plan needs rewriting.
- MySQL templates already use a different privilege model than `<username>_*`.
- You discover that MySQL 8.4 no longer treats `_` / `%` as wildcards in GRANT database patterns; cite the evidence and ask for review before changing templates.
- The fix appears to require changing username/database naming rules or existing tenant database names.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

Reviewers should look carefully at escaping semantics: this plan is about MySQL grant database-pattern wildcards, not SQL string escaping. Future DB-related commands should call the shared helper instead of hard-coding grant strings. If VibeOps later changes from pattern grants to per-database grants, this helper may become unnecessary, but until then it prevents valid usernames containing `_` from broadening access.
