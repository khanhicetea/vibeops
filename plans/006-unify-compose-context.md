# Plan 006: Route every Docker Compose invocation through one local-overlay context

> **Executor instructions**: Follow every step and test argument ordering exactly. Stop if Docker Compose semantics differ from the assumptions below. Update the plan index when done.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/helpers.py vibeops/runtime_commands.py vibeops/db_commands.py vibeops/permission_commands.py vibeops/app_commands.py vibeops/cron_commands.py tests docs/customization.md README.md`
> Plan 001 may add CI/tests. Other completed plans may change nearby handlers; preserve their behavior.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-and-ci.md`
- **Category**: bug / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

VibeOps documents `compose.local.yml` and `compose.d/*.yml` as conflict-free customization surfaces, but only `./manage.py compose` includes them. Internal commands use bare `docker compose` 24 times, so shell/exec fallback containers, permission helpers, status, validation, database commands, and reloads can ignore custom mounts, environment, service definitions, or image overrides.

## Current state

```python
# vibeops/runtime_commands.py:157-175
def compose_files():
    files = [ROOT / "compose.yml"]
    for path in [ROOT / "compose.override.yml", ROOT / "compose.local.yml"]:
        ...
    files.extend(sorted(compose_d.glob("*.yml")))
    ...

def cmd_compose(args):
    cmd = ["docker", "compose"]
    for path in files:
        cmd.extend(["-f", str(path)])
```

Examples bypassing it:

```python
# vibeops/helpers.py:461-465
run(["docker", "compose", "ps", "--services", ...])

# vibeops/runtime_commands.py:70-74
os.execvp("docker", ["docker", "compose", "run", "--rm", ..., php_cli_service, ...])

# vibeops/db_commands.py:47-50
["docker", "compose", "exec", "-T", service, "sh", "-lc", ...]
```

`docs/customization.md:95-103` promises the base file, `compose.override.yml`, `compose.local.yml`, and sorted `compose.d/*.yml|*.yaml` are loaded by VibeOps.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_compose_context` | all pass |
| Bare call audit | `rg -n '"docker", "compose"|\["docker", "compose"' vibeops` | matches only the central builder/module |
| Full gate | `make check` | exit 0 |
| Compose config | `make compose-check` | exit 0 when Docker exists |

## Scope

**In scope**:

- `vibeops/compose.py` (create; one focused module is justified now)
- All `vibeops/*.py` files containing Docker Compose argv construction
- `tests/test_compose_context.py` (create)
- Existing subprocess assertion tests
- `docs/customization.md`
- `README.md` where direct commands conflict with the wrapper

**Out of scope**:

- Generating services for arbitrary PHP versions
- Changing Compose project name
- Rewriting `compose.yml`
- Docker SDK dependencies
- Running Compose through a shell string
- General module decomposition (Plan 011)

## Git workflow

- Branch: `advisor/006-compose-context`
- Commit message: `unify compose command context`.
- Do not push.

## Steps

### Step 1: Create a side-effect-free Compose context module

Create `vibeops/compose.py` with explicit imports and functions similar to:

```python
def compose_files(root: Path = ROOT) -> list[Path]: ...
def compose_prefix(root: Path = ROOT) -> list[str]: ...
def compose_command(*args: str, root: Path = ROOT) -> list[str]: ...
```

Requirements:

- First file is `compose.yml`.
- Include existing `compose.override.yml`, then `compose.local.yml`.
- Include `compose.d/*.yml` and `*.yaml` in one deterministic lexical ordering by full filename; do not group extensions in a way that makes `20-x.yaml` precede `10-y.yml`.
- Avoid duplicate paths/symlink aliases.
- Return argv lists, never shell strings.
- Use paths relative to root when practical for readable diagnostics, or absolute paths consistently. Tests must define the contract.
- If base `compose.yml` is absent, raise `StackError` before Docker execution.

**Verify**: temporary-directory tests cover no overlays, every overlay type, mixed extension ordering, duplicates, and missing base.

### Step 2: Replace every internal invocation

Use `compose_command()` for:

- service discovery/status;
- Nginx test/reload;
- PHP identity/FPM validation/reload;
- cron test/reload;
- permission helper `exec` and fallback `run`;
- app CLI `run`/shell;
- MySQL exec, shell, dump, restore, and ping;
- `apply` validation;
- public `cmd_compose` passthrough.

Keep `os.execvp("docker", argv)` where replacing the process is intentional. Preserve existing TTY flags and argument order after the Compose prefix.

Do not rely on Docker's implicit auto-loading of `compose.override.yml`; because `-f compose.yml` is explicit, include every intended file explicitly.

**Verify**: bare-call audit returns only the literal central prefix in `vibeops/compose.py`.

### Step 3: Update subprocess tests

Update `tests/test_php_reload.py` and add `tests/test_compose_context.py` to assert complete argv with all configured `-f` entries. Include regression cases for:

1. `cmd_app_exec` uses a `compose.d` volume override.
2. Permission fallback `compose run` includes overlays.
3. MySQL dump and shell include overlays.
4. Status/service discovery includes overlays.
5. `cmd_compose` appends user arguments after all file flags.
6. Filenames containing spaces remain one argv item.

Patch `compose_files`/root; do not create real developer overlay files.

**Verify**: focused tests and updated reload tests pass.

### Step 4: Make diagnostics print reproducible commands

Where messages currently advise bare `docker compose`, prefer `./manage.py compose ...` so operators reproduce the exact context. Do not change README bootstrap commands that intentionally demonstrate stock Compose unless local-fragment behavior matters there.

Add an optional helper to format argv with `shlex.join()` for diagnostics only; execution remains list-based. Never format commands containing credentials.

**Verify**: `rg -n "run: docker compose|then run: docker compose" vibeops` has no stale operational guidance.

### Step 5: Update customization documentation

State explicitly that all `manage.py` operations now use the same ordered Compose file set, including ephemeral CLI and fallback helper containers. Add a verification example:

```bash
./manage.py compose config > /tmp/vibeops-compose.yml
./manage.py exec <app> -- env
```

Do not claim direct `docker compose` loads `compose.local.yml` or `compose.d`.

**Verify**: docs name `exec`, `permissions`, `database`, and `apply` as using the common context.

## Test plan

Tests should assert argv lists rather than printed strings. Use mixed `.yml`/`.yaml` fixtures and ensure deterministic ordering. Add a no-secret assertion for DB-related commands: expected argv may contain option-file paths but not credential values.

## Done criteria

- [ ] One module owns Compose file discovery and argv construction.
- [ ] Every internal Compose invocation uses it.
- [ ] Mixed extension fragments are deterministically ordered.
- [ ] Ephemeral/fallback containers honor local overlays.
- [ ] Existing TTY and exec behavior is preserved.
- [ ] Focused tests, `make check`, and available Compose smoke pass.
- [ ] Plan 006 is marked DONE.

## STOP conditions

- Explicit `-f compose.yml -f compose.override.yml` produces materially different merge behavior from documented implicit loading.
- A command intentionally must ignore local overlays; report that command and rationale instead of special-casing silently.
- Correct behavior requires changing the Compose project name or working directory.
- A subprocess command would need a shell string.

## Maintenance notes

Future Docker Compose calls must start with `compose_command()`. Add a lightweight source-invariant test that fails if bare `"docker", "compose"` literals appear outside the central module. This protects the customization contract from regression.
