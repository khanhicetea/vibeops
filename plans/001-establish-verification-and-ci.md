# Plan 001: Establish one-command verification and Linux CI

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report; do not improvise. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- tests README.md pyproject.toml Makefile .github/workflows/ci.yml`
> At the planned commit, `pyproject.toml`, `Makefile`, `.github/workflows/ci.yml`, and `tests/__init__.py` do not exist. If those paths now implement equivalent verification, stop and reconcile rather than creating duplicates.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

The default unittest command currently exits 5 after discovering zero tests, while a specially scoped command finds eight. There is no committed CI, lint configuration, or documented contributor verification command. Every later operational change needs a deterministic, no-secret gate that works locally on macOS and in Linux CI.

## Current state

- `tests/test_cron.py:12-67` contains six cron validation/render tests.
- `tests/test_php_reload.py:10-39` contains two mocked PHP reload tests.
- `docs/architecture.md:66` says a non-Docker test suite exists but does not provide its command.
- `tests/` lacks `__init__.py`, so `python3 -m unittest discover` does not recurse into it in this repository.
- No `.github/`, `pyproject.toml`, Makefile, `.editorconfig`, or pre-commit configuration is tracked.
- The CLI intentionally uses the Python standard library only. Do not add runtime dependencies.

Current verification:

```text
$ python3 -B -m unittest discover
Ran 0 tests
NO TESTS RAN
(exit 5)

$ python3 -B -m unittest discover -s tests
Ran 8 tests
OK
```

Conventions to preserve:

- Tests use `unittest`, `tempfile`, and `unittest.mock`; model new harness tests after `tests/test_cron.py`.
- Commands must set `PYTHONDONTWRITEBYTECODE=1` or use `python3 -B` so verification does not dirty the tree.
- Docker integration belongs in Linux CI; local checks must remain useful when Docker is unavailable.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Existing tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v` | 8 tests pass |
| Default discovery after fix | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -v` | 8 or more tests pass, exit 0 |
| Shell syntax | `for f in docker/php/bin/* .pi/skills/vibeops/scripts/*.sh; do sh -n "$f"; done` | exit 0 |
| Final local gate | `make check` | exit 0 |

## Scope

**In scope**:

- `tests/__init__.py` (create)
- `tests/test_cli_smoke.py` (create)
- `pyproject.toml` (create; tool configuration only, no runtime package dependency)
- `Makefile` (create)
- `.github/workflows/ci.yml` (create)
- `README.md` (add a concise development/verification section)

**Out of scope**:

- Production behavior under `vibeops/`, `compose.yml`, `config/`, or `docker/`
- Installing a Python packaging framework or converting `manage.py` into a published package
- Docker image builds for all database versions; keep the first CI matrix bounded
- Coverage percentage gates; critical-path tests are added by later plans
- Formatting the entire repository

## Git workflow

- Branch: `advisor/001-verification-ci`
- Use short imperative commit messages consistent with history, e.g. `add verification baseline`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Fix default unittest discovery

Create an empty `tests/__init__.py`. Add `tests/test_cli_smoke.py` using `unittest` and `subprocess` to verify:

1. `python3 -B manage.py --help` exits 0 and includes `app`, `render`, `compose`, and `status`.
2. `python3 -B -m vibeops --help` exits 0 with the same program surface.
3. Importing every `vibeops.*` module succeeds without Docker or `.env`.
4. The repository's `.env.example` remains a template; tests must never create root `.env`.

Run subprocesses with `cwd` set to the repository root and `PYTHONDONTWRITEBYTECODE=1` in the environment.

**Verify**: `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -v` → at least 12 tests pass, exit 0.

### Step 2: Add a dependency-free local check command

Create a `Makefile` with these phony targets:

- `test`: default unittest discovery with `python3 -B`.
- `python-syntax`: parse every tracked/project `.py` file with `ast.parse`; skip `.git`, runtime data, and `__pycache__`.
- `shell-syntax`: run `sh -n` on `docker/php/bin/*`; run `bash -n` on `.pi/skills/vibeops/scripts/*.sh` because that script uses Bash syntax.
- `check`: run `python-syntax`, `shell-syntax`, then `test`.
- `compose-check`: require Docker, create a temporary environment file outside the repository or export a non-secret CI placeholder, run `./manage.py render`, and then `docker compose config -q`. It must not overwrite a developer's `.env`.

Do not make `check` depend on Docker.

**Verify**: `make check` → syntax checks and all tests pass, exit 0; `git status --short` shows no `__pycache__` or runtime artifacts.

### Step 3: Add focused Ruff configuration without making it a local prerequisite

Create `pyproject.toml` with project metadata only if needed by tools and a `[tool.ruff]` configuration targeting the repository's supported Python version. Configure a conservative initial ruleset that catches syntax errors, undefined names, and obvious defects. Account explicitly for the current wildcard-import architecture (`F403`/`F405`) until Plan 011 removes it; do not hide unrelated findings globally.

Ruff is a CI/developer dependency, not a VibeOps runtime dependency.

**Verify**: in an environment with Ruff, `ruff check .` → exit 0. If Ruff reports existing non-wildcard defects, fix only test/tooling issues in scope or STOP and report production-file changes needed.

### Step 4: Add Linux CI

Create `.github/workflows/ci.yml` triggered for pushes and pull requests. Use least-privilege workflow permissions (`contents: read`). Add jobs:

1. **python-checks** on Ubuntu with the project's supported Python version:
   - install Ruff at a pinned major/minor range;
   - run `make check`;
   - run `ruff check .`.
2. **compose-smoke** on Ubuntu:
   - copy `.env.example` to a temporary CI env file or set required variables in the job environment;
   - run `./manage.py render`;
   - run `docker compose config -q` using the same file-selection behavior expected by the base stack;
   - assert generated Nginx, PHP fallback, cron, and protected MySQL option files exist with expected modes;
   - never print credential content.

Do not build/start all images in this first baseline. If a cheap Nginx config test cannot run without building custom modules, defer it in a comment and Plan 005.

**Verify**: validate YAML with an available parser or GitHub Actions tooling; `make check` and local `docker compose config -q` (when Docker exists) pass.

### Step 5: Document the contributor gate

Add a short `Development verification` section to `README.md` with:

```bash
make check
# Optional when Docker is installed:
make compose-check
```

State that tests are standard-library based, Docker checks run in Linux CI, and production runtime files must remain uncommitted.

**Verify**: `grep -n "make check\|make compose-check" README.md` → both commands are present.

## Test plan

- Use `tests/test_cli_smoke.py` for help/import smoke coverage.
- Preserve all eight existing tests unchanged unless a test-only import path needs correction.
- Confirm both scoped and default discovery pass.
- Confirm running the gate twice does not change `git status`.

## Done criteria

- [ ] `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -v` exits 0 and runs at least 12 tests.
- [ ] `make check` exits 0 twice consecutively.
- [ ] `ruff check .` is configured and passes in CI.
- [ ] CI runs Python checks and Compose rendering/config validation without secrets.
- [ ] `git status --short` contains only intended in-scope files and `plans/README.md`.
- [ ] No runtime dependency was added.
- [ ] Plan 001 is marked DONE in `plans/README.md`.

## STOP conditions

- Default discovery still reports zero tests after adding `tests/__init__.py`.
- CI requires a real secret or a committed `.env` to render Compose.
- Passing Ruff requires modifying production modules; defer those changes to Plan 011.
- Docker Compose validation requires starting or mutating production services.
- The repository's supported Python version is documented below a version required by current type syntax.

## Maintenance notes

Keep `make check` fast and Docker-free so executors run it after every step. Add focused tests to the existing unittest suite rather than introducing a second test framework. A later CI expansion may build PHP/Nginx images, but it should use caching and a bounded version matrix.
