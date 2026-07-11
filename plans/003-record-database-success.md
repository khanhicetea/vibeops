# Plan 003: Record databases only after successful MySQL creation

> **Executor instructions**: Follow the steps and run every verification. Stop on a STOP condition and report instead of weakening failure behavior. Update `plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/app_commands.py vibeops/helpers.py vibeops/db_commands.py tests README.md`
> Plan 001 test additions and Plan 002 PHP-resolution changes are expected. Reconcile any changes to `cmd_app_create`, `create_database`, or `ensure_mysql_database` before editing.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-establish-verification-and-ci.md`
- **Category**: bug
- **Planned at**: commit `84b3cfb`, 2026-07-11
- **Status**: DONE

## Why this matters

When `app create` receives a database suffix while MySQL is stopped or unconfigured, the helper logs that creation was skipped but returns the intended name. The caller then stores that name in desired state, so `app db list` claims a nonexistent database is available. Explicit database intent must either succeed or fail before being recorded.

## Current state

```python
# vibeops/helpers.py:749-765
def create_database(app_name, suffix, mysql_service):
    """Best-effort database create used by app create (skips when mysql is down)."""
    db_full_name = f"{app_name}_{suffix}"
    ...
    if ready:
        mysql_root_exec_sql(...)
    else:
        info("Skipped database creation ...")
    return db_full_name
```

```python
# vibeops/app_commands.py:45-50
if args.db_suffix:
    db_full_name = create_database(app_name, args.db_suffix, mysql_service)
    if db_full_name and db_full_name not in app.setdefault("databases", []):
        app["databases"].append(db_full_name)
    if db_full_name:
        app.setdefault("database_services", {})[db_full_name] = mysql_service
```

A stricter helper already exists: `ensure_mysql_database()` at `vibeops/helpers.py:730-746` raises when `.env`, service readiness, or root credentials are missing. Follow the repository's `StackError`/`die()` convention and never print credentials.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_database_state` | all pass |
| Full gate | `make check` | exit 0 |

## Scope

**In scope**:

- `vibeops/app_commands.py`
- `vibeops/helpers.py`
- `vibeops/db_commands.py` only if consolidating duplicate create logic
- `tests/test_database_state.py` (create)
- `README.md` only for one failure-semantics clarification

**Out of scope**:

- Backup/restore behavior (Plan 008)
- Credential transport (Plan 010)
- MySQL schema changes or migrations
- Making all app creation globally transactional with external MySQL; this plan only guarantees truthful state
- Retrying MySQL startup or starting services automatically

## Git workflow

- Branch: `advisor/003-database-success-state`
- Commit message: `fix skipped database state`.
- Do not push.

## Steps

### Step 1: Make explicit database creation strict

Remove the ambiguous best-effort contract. Preferred implementation:

- Use `ensure_mysql_database()` for `app create` when `db_suffix` is supplied.
- Perform a readiness preflight before database metadata is appended.
- Return a database name only after `mysql_root_exec_sql()` succeeds.
- On unavailable service, missing protected option file/root configuration, or SQL failure, raise `StackError` and do not append `databases` or `database_services`.

If `create_database()` remains for compatibility, change its type and behavior so skipped creation returns `None`; no caller may treat `None` as success. Prefer deleting it if no legitimate best-effort caller remains.

Do not alter app creation without a database suffix: MySQL user creation may remain optional/best effort as currently documented.

**Verify**: `rg -n "def create_database|create_database\(" vibeops` shows either no obsolete helper or only callers that handle `None` explicitly.

### Step 2: Preflight before avoidable local side effects

In `cmd_app_create()`, validate DB suffix and required MySQL readiness before writing the starter index, generated vhost, or desired database metadata. It is acceptable that pre-existing app identity setup remains a separate concern, but a known-unavailable database should fail as early as practical.

Reuse `_require_mysql_service()` only if doing so does not introduce an import cycle between `app_commands.py` and `db_commands.py`. Otherwise create a narrowly named readiness helper in the existing MySQL helper area. Do not solve an import cycle with another wildcard import.

**Verify**: mocked test asserts unavailable MySQL raises before `mysql_root_exec_sql`, `save_db`, and database-list mutation.

### Step 3: Add regression tests

Create `tests/test_database_state.py` using `unittest.mock`. Cover:

1. MySQL unavailable: explicit suffix raises and leaves `databases` and `database_services` unchanged.
2. Missing root credential/config: same behavior.
3. SQL command failure: same behavior.
4. SQL success: exactly one database entry and one service mapping are stored.
5. Repeating successful creation is idempotent in state.
6. App creation without suffix retains existing best-effort account behavior.

Do not write a real `.env`, credential file, or runtime state. Patch helper boundaries and use temporary directories where filesystem output must be observed.

**Verify**: focused tests pass, then `make check` passes.

### Step 4: Document truthful failure behavior

Near the `app create` database example, state that supplying a database suffix requires the selected MySQL service to be ready; the command fails rather than recording a skipped database. Mention `--no-mysql` cannot be combined with a suffix, preserving current behavior.

**Verify**: README includes the terms `database suffix`, `MySQL service`, and `fails` in the app-create section.

## Test plan

Use mocked `mysql_root_exec_sql` return/failure behavior. The key assertion is the persisted/in-memory state, not only emitted messages. Include a deep copy of the app record before failure and assert equality afterward for database-related keys.

## Done criteria

- [x] A skipped or failed SQL operation cannot return a successful database name.
- [x] `cmd_app_create` records DB metadata only after successful SQL execution.
- [x] Existing successful DB creation remains idempotent.
- [x] No password or SQL credential is printed by tests or errors.
- [x] Focused tests and `make check` pass.
- [x] Plan 003 is marked DONE.

## STOP conditions

- A documented caller intentionally depends on recording a planned-but-not-created database.
- Readiness cannot be checked without starting/mutating Docker services.
- Fixing the behavior requires changing credential-file format or database grants.
- The implementation creates an import cycle; stop and report the proposed module boundary instead of adding a wildcard workaround.

## Maintenance notes

Desired state should describe resources VibeOps has successfully established, unless a future explicit reconciliation state machine adds statuses such as `pending` and `failed`. Do not reintroduce a single string return value that means both “created” and “intended.”
