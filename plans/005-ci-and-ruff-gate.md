# Plan 005: Add CI workflow and expand the Ruff gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- Makefile pyproject.toml .github/ tests/test_module_invariants.py`
> On mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / tests
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

The repo already has a one-command verification gate (`make check`) and solid unit tests, but there is **no** `.github/workflows` CI and Ruff is configured with only a tiny rule set (syntax/undefined-name style). Contributors and coding agents can merge regressions that `make check` would catch if it ran automatically. Expanding Ruff modestly and wiring GitHub Actions locks the existing quality bar.

## Current state

- `Makefile`:

```makefile
check: syntax test
syntax:
	@python3 -B -c 'import ast, ...'
test:
	PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v
```

- `pyproject.toml` — ruff target py311, line-length 120, select only `E9`, `F63`, `F7`, `F82`, `F401`, `F403`, `F405`
- No `.github/` directory
- Stdlib-only runtime; tests use unittest
- `tests/test_module_invariants.py` forbids star imports

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Full local gate | `make check` | exit 0 |
| Ruff (after install in CI/local) | `python3 -m ruff check bento tests manage.py` | exit 0 |
| Unit tests | `python3 -B -m unittest discover -s tests -v` | all pass |

## Scope

**In scope**:
- `.github/workflows/ci.yml` (new)
- `pyproject.toml` — expand `[tool.ruff]` select list carefully
- `Makefile` — add `lint` target; make `check` depend on lint **if** ruff is available, or document `pip install ruff` in CI only and keep local `check` free of deps
- `README.md` — one line under development: CI runs `make check` / ruff

**Out of scope**:
- Adding mypy/pyright (can be a later plan)
- Pre-commit hooks (optional mention only)
- Reformatting the entire codebase with ruff format as a requirement (optional; if `ruff format --check` fails widely, skip format check in this plan)
- pytest migration

## Git workflow

- Branch: `advisor/005-ci-ruff`
- Commit style: e.g. `ci and ruff gate`
- Do not push unless asked

## Design constraints

1. **Keep zero runtime deps for the CLI.** Ruff is a **dev/CI** dependency only.
2. **Local `make check` must still work without pip-installing anything** on a bare Python 3.11+ host (current property). Therefore:
   - CI installs ruff and runs it
   - Local Makefile: `lint` target runs ruff if present, else prints skip — **or** `check` stays syntax+test and CI runs `ruff` + `make check` as separate steps
3. Expand Ruff rules that are high-signal and low-churn for this codebase:
   - Keep existing selects
   - Add gradually: `F` (pyflakes full), `E`/`W` pycodestyle selected codes that don’t fight style, `I` isort only if imports are already clean — **if enabling a rule causes >20 easy fixes, fix them; if hundreds of noisy findings, drop that rule from this plan**
4. Recommended safe expansion:

```toml
select = [
  "E9", "F63", "F7", "F82",
  "F401", "F403", "F405",
  "F811", "F821", "F822", "F823",
  "E71", "E72", "E74",
  "UP",  # only if few findings; otherwise omit
]
```

Start by running ruff with broader select locally in CI job first; only commit rules that are clean or fixed.

## Steps

### Step 1: Run ruff baseline

If ruff not installed: `pip install ruff` in a throwaway venv (`.venv` may already exist).

```bash
python3 -m ruff check bento tests manage.py
```

Record findings. Fix auto-fixable issues that are clearly correct. Do not enable rules you will not fix in this plan.

### Step 2: Update `pyproject.toml`

Commit the final `select` list that is green.

### Step 3: Makefile

```makefile
.PHONY: check test syntax lint

lint:
	@python3 -m ruff check bento tests manage.py

# Prefer: check remains dependency-free
check: syntax test
```

CI will call `lint` separately.

### Step 4: GitHub Actions

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - name: Install ruff
        run: pip install ruff
      - name: Ruff
        run: python -m ruff check bento tests manage.py
      - name: make check
        run: make check
```

No secrets needed. Do not run docker-compose integration in this plan.

### Step 5: README + gate

Document CI. Run `make check` and ruff locally.

## Test plan

- CI file is valid YAML (Actions will validate on push)
- Existing unittest suite unchanged in behavior
- No new runtime dependency in `pyproject.toml` project table

## Done criteria

- [ ] `.github/workflows/ci.yml` exists and runs ruff + `make check`
- [ ] Ruff config expanded beyond the original micro set **or** documented why expansion was limited after baseline
- [ ] Local `make check` still works without ruff installed
- [ ] `make check` + `ruff check` pass in the environment used for development
- [ ] `plans/README.md` → DONE

## STOP conditions

- Enabling a Ruff rule requires mass stylistic rewrites unrelated to correctness — drop the rule
- Project owner uses a different CI (Forgejo/Gitea only) — still add GitHub workflow if remote is GitHub; if not, add equivalent notes and a `scripts/ci.sh` instead

## Maintenance notes

- Next DX step: optional `ruff format` and mypy on `bento/utils` only
- Do not add pytest until there is a reason; unittest is fine
