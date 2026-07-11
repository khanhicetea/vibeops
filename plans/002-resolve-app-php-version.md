# Plan 002: Resolve app PHP versions from state without implicit migration

> **Executor instructions**: Follow every step and verification gate. Stop on any STOP condition; do not invent a compatibility policy. Update the status row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/parser.py vibeops/app_commands.py vibeops/runtime_commands.py vibeops/cron_commands.py vibeops/helpers.py vibeops/wizard_commands.py tests`
> Changes from completed Plan 001 are expected under `tests/`. Any behavior change in the listed `vibeops/` symbols must be reconciled before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-and-ci.md`
- **Category**: bug / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

`cron`, `exec`, and explicit-app `shell` currently default to the stack PHP version instead of the app's recorded PHP version. If the matching generated identity is absent, `ensure_app()` calls `ensure_app_identity()`, which overwrites the app's primary `php_version`. A routine shell or cron command can therefore run on the wrong runtime or silently migrate the web app.

## Current state

Relevant parser defaults:

```python
# vibeops/parser.py:154-159
cron_create.add_argument("app_name")
...
cron_create.add_argument("--php", default=default_php_version(), help="PHP version")

# vibeops/parser.py:177-186
app_exec.add_argument("--php", default=default_php_version(), help="PHP version")
...
shell.add_argument("--php", default=default_php_version(), help="PHP version")
```

Current side effect:

```python
# vibeops/app_commands.py:68-72
def ensure_app(app_name, php_version, db, ...):
    if app_name in db.get("apps", {}) and (... / f"{app_name}.env").exists():
        return db["apps"][app_name]
    return ensure_app_identity(app_name, php_version, db, ...)

# vibeops/helpers.py:775-781
app = db["apps"].setdefault(app_name, {"name": app_name})
...
app["php_version"] = php_version
app["php_service"] = php_service
```

`cmd_app_exec()` always saves after `ensure_app()` (`vibeops/runtime_commands.py:61-63`). `cmd_cron_create()` does the same through its final state save (`vibeops/cron_commands.py:92-137`).

Documented architecture says PHP-FPM, CLI, Composer, and cron use the same PHP binary/extensions (`README.md`, Architecture section). Preserve that single-primary-runtime model: an existing app's cron/exec/shell should use its recorded version unless an explicit app migration command changes it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Full gate | `make check` | exit 0 |
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_php_version_resolution` | all pass |
| CLI help | `python3 -B manage.py exec --help && python3 -B manage.py cron create --help` | exit 0; `--php` remains available |

## Scope

**In scope**:

- `vibeops/parser.py`
- `vibeops/app_commands.py`
- `vibeops/runtime_commands.py`
- `vibeops/cron_commands.py`
- `vibeops/wizard_commands.py` only if Namespace construction must change
- `vibeops/helpers.py` only for a small shared resolver if it cannot live cleanly in `app_commands.py`
- `tests/test_php_version_resolution.py` (create)
- `README.md` only if command semantics need one concise clarification

**Out of scope**:

- Adding arbitrary secondary PHP runtimes per app
- Changing Compose services or available PHP versions
- Deleting historical generated pools; transactional cleanup is Plan 005
- FPM resource profiles; Plan 009
- State lock changes; Plan 004
- Broad import cleanup; Plan 011

## Git workflow

- Branch: `advisor/002-app-php-resolution`
- Commit message example: `fix app php version resolution`.
- Do not push.

## Steps

### Step 1: Represent an omitted `--php` distinctly

Change parser defaults for these commands from `default_php_version()` to `None`:

- `app create --php`
- `cron create --php`
- `exec --php`
- `shell --php`

Keep `--php` explicit for `identity`, `permissions`, deprecated compatibility commands, and commands that operate directly on a version rather than an app. Update help text to say omitted values use the existing app's version, or the stack default for a new app.

Do not infer omission by comparing a supplied value to the current default; that cannot distinguish an explicit `--php 8.4` from omission.

**Verify**: parser-focused tests assert `args.php is None` when omitted and the exact string when supplied.

### Step 2: Add one canonical resolver

Implement a side-effect-free function with this behavior:

```python
def resolve_app_php_version(db, app_name, requested=None, *, allow_new=True) -> str:
    # Existing app + omitted: recorded app php_version.
    # Existing app + explicit same version: that version.
    # Existing app + explicit different version: StackError with migration guidance.
    # Unknown app + omitted + allow_new: validated default_php_version().
    # Unknown app + explicit + allow_new: validated explicit version.
    # Unknown app + not allow_new: StackError.
```

Use existing `validate(..., PHP_VERSION_RE, ...)` and `StackError` conventions. The mismatch error must name both versions and direct users to `./manage.py app create <app> <main-domain> --php <version>` for an intentional web-app migration. Do not mutate `db`.

For `app create`, explicit mismatch is the intentional migration path, so resolve differently: omitted preserves an existing app's version; explicit values are allowed to become the new primary version.

**Verify**: unit tests cover existing/omitted, existing/same, existing/mismatch, unknown/omitted, unknown/explicit, and malformed state values.

### Step 3: Apply the resolver before any side effect

Update:

- `cmd_app_create()` to resolve before `ensure_app_identity()`; rerunning `app create` without `--php` must preserve the app runtime.
- `cmd_cron_create()` to resolve before rendering, identity creation, or cron reload.
- `cmd_app_exec()` and `cmd_app_shell()` to resolve before `ensure_app()` or `os.execvp()`.
- Wizard Namespace creation to pass an explicit selected value where the wizard asks the user, preserving current wizard behavior.

For an existing app, `ensure_app()` must never call `ensure_app_identity()` with a different primary version. Add a defensive invariant inside `ensure_app()` so future callers cannot bypass the resolver. Unknown-app provisioning may retain current behavior.

Remove the unconditional `save_db(db)` from `cmd_app_exec()` when no state mutation is required. A shell/exec command must not rewrite desired state merely to launch a container.

**Verify**: mocked tests assert no call to `ensure_app_identity`, `save_db`, Docker, render, or reload occurs on an explicit mismatch.

### Step 4: Add regression tests around command handlers

Create `tests/test_php_version_resolution.py`. Patch filesystem/Docker helpers; do not create root runtime state. Cover:

1. Existing PHP 8.5 app + `exec` without `--php` selects `php85-cli`.
2. Existing PHP 8.5 app + `shell shop` without `--php` selects PHP 8.5.
3. Existing PHP 8.5 app + cron without `--php` stores/renders PHP 8.5.
4. Existing PHP 8.5 app + explicit `--php 8.4` fails before side effects.
5. Existing PHP 8.5 app + rerun `app create` without `--php` stays 8.5.
6. New app + omitted `--php` uses `.env`/stack default.
7. Explicit app migration through `app create --php` remains possible.

When testing `cmd_app_exec`, patch `os.execvp` and inspect the command instead of launching Docker.

**Verify**: focused test module passes and `make check` passes.

### Step 5: Clarify the command contract

In README command examples, state once that app-scoped commands use the app's recorded PHP version by default. Explain that `--php` on `app create` is the supported primary-runtime migration operation; `cron`, `exec`, and `shell` reject a mismatched explicit version.

**Verify**: `grep -n "recorded PHP version\|primary.*PHP" README.md` finds the clarification.

## Test plan

Model mocking and command assertions after `tests/test_php_reload.py`. Test both parser and handler behavior; parser-only tests would not catch the original state mutation. Include a regression assertion that the original app dict is unchanged after failed resolution.

## Done criteria

- [x] Omitted app-scoped `--php` values are represented as `None` by argparse.
- [x] Existing app operations resolve to `app["php_version"]`.
- [x] Cron/exec/shell cannot implicitly change primary PHP version.
- [x] `cmd_app_exec()` does not save unchanged state.
- [x] Intentional migration through `app create --php` still works.
- [x] Focused tests and `make check` pass. (`make check` unavailable until Plan 001; full `unittest discover` passes.)
- [x] No Docker service is required for unit tests.
- [x] Plan 002 is marked DONE.

## STOP conditions

- Existing documentation or tests prove secondary per-app PHP runtimes are a supported requirement.
- Fixing the bug requires changing the state schema rather than only resolution semantics.
- An existing command depends on `cmd_app_exec()` rewriting state.
- A mismatch cannot be rejected without breaking a documented workflow; report the workflow and propose a separate secondary-runtime design.

## Maintenance notes

Any future app-scoped command should accept `None` for an omitted runtime and call the same resolver. Never use equality with `default_php_version()` to detect whether the user explicitly supplied a flag. Reviewers should scrutinize all paths that call `ensure_app_identity()` because that function deliberately changes primary app metadata.
