# Plan 011: Decompose shared helpers and remove wildcard import chains

> **Executor instructions**: This is a behavior-preserving refactor after Plans 001–010. Work incrementally, run `make check` after each module extraction, and stop on behavior drift. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops tests manage.py`
> Extensive drift from completed prerequisite plans is expected. Before starting, regenerate a fresh symbol/import inventory from HEAD and treat the live expanded tests as canonical. Stop if any earlier plan is not DONE.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 001 through 010
- **Category**: tech-debt / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

`vibeops/helpers.py` currently contains paths, validation, state persistence, locking, subprocesses, Compose service control, MySQL operations, rendering, app identity, TLS mutation, cron generation, and more. It has 79 top-level functions across 946 lines. Most command modules wildcard-import it; parser wildcard-imports a compatibility module that wildcard-imports all handlers. Dependencies and circularity are hidden, making static analysis and safe customization difficult.

## Current state

```python
# vibeops/parser.py:4-6
import argparse
from vibeops.commands import *
```

```python
# vibeops/commands.py:8-16
from vibeops.helpers import *
from vibeops.app_commands import *
from vibeops.db_commands import *
from vibeops.proxy_commands import *
from vibeops.cron_commands import *
from vibeops.tls_commands import *
from vibeops.runtime_commands import *
from vibeops.permission_commands import *
from vibeops.wizard_commands import *
```

Every major command module also contains `from vibeops.helpers import *`. `runtime_commands.py` imports app and cron modules; `cron_commands.py` imports app commands; wizard imports multiple handlers. Current tests rely on patching symbols on `vibeops.helpers`, so relocation needs deliberate compatibility/test updates.

Repository conventions after Plan 001:

- Standard-library runtime only.
- `unittest` tests and `make check` are required.
- `StackError` is the user-facing operational exception.
- Plan 006 already establishes `vibeops/compose.py`; do not duplicate it.
- Plan 005's render transaction and Plan 004's state transaction are load-bearing boundaries.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Baseline | `make check` | exit 0 before edits |
| Wildcard audit | `rg -n 'import \*' vibeops tests` | no matches when done |
| Import smoke | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_cli_smoke` | all pass |
| Full gate | `make check` | exit 0 after every extraction |
| Cycle check | `python3 -B -c 'from vibeops.parser import build_parser; build_parser()'` | exit 0 |

## Scope

**In scope**:

- All `vibeops/*.py`
- Tests whose imports/patch targets move
- `manage.py` only if import path needs a minimal update
- `pyproject.toml` Ruff settings after wildcard removal
- `docs/architecture.md` module map

**Out of scope**:

- CLI command/flag/output changes
- State schema or generated-file format changes
- New runtime dependencies
- Rewriting the CLI with Click/Typer
- Converting all dict state to dataclasses in one pass
- Performance/security behavior changes not already covered by tests
- Removing deprecated commands; do that in a separate compatibility plan

## Git workflow

- Branch: `advisor/011-decompose-helpers`
- Make one commit per extracted concern so regressions can be bisected, e.g. `split state helpers`, `split render helpers`, `remove wildcard command exports`.
- Do not push.

## Steps

### Step 1: Inventory symbols and establish characterization protection

Before moving code, generate:

- every top-level symbol in each module;
- import edges between `vibeops` modules;
- every test patch target;
- every externally imported symbol from `vibeops.commands` and `vibeops.helpers` within the repository.

Save no generated inventory unless it is useful developer documentation. Add characterization tests for any public behavior not already covered by Plans 001–010, especially parser construction and command callback wiring.

Define a target dependency direction:

```text
errors/paths/validation
        ↓
state + template + compose/process
        ↓
rendering + mysql + services
        ↓
command modules
        ↓
parser / wizard / cli
```

Command modules must not be imported by lower-level utility modules.

**Verify**: baseline and new characterization tests pass before moving symbols.

### Step 2: Extract foundational modules

Create focused modules with explicit `__all__` only where a public surface is intentional:

- `vibeops/errors.py`: `StackError`, `die`, output helpers if appropriate.
- `vibeops/paths.py`: immutable root/path constants and any post-Plan-005 render path context.
- `vibeops/validation.py`: regexes and pure validators.
- `vibeops/env.py`: env parsing/defaults/password-presence helpers; never secret logging.
- `vibeops/state.py`: schema normalization, load/save, Plan 004 lock/transaction, timestamps, UID allocation if state-bound.

Avoid a generic `utils.py`. Each module must have one clear reason to change. Use explicit imports and type annotations.

After each extraction, update direct users and tests; do not maintain duplicate implementations.

**Verify after each module**: `make check` passes and `python3 -B manage.py --help` exits 0.

### Step 3: Extract operational service modules

Move cohesive behavior into:

- `vibeops/mysql.py`: SQL literals/grants, option files, admin execution, metadata helpers; command handlers remain in `db_commands.py`.
- `vibeops/rendering.py`: template-to-file specifications and Plan 005 transaction integration.
- `vibeops/php.py`: version/service naming, identity/pool render and reload operations.
- `vibeops/cron.py` or retain `cron_commands.py` plus a lower-level `cron_runtime.py`: pure cron validation/render/aggregate/reload helpers.
- `vibeops/nginx.py`: vhost/TLS render values and validate/reload operations.
- Keep Plan 006's `vibeops/compose.py` as the sole Compose argv owner.

Do not create modules that import command handlers. Where two services need a shared primitive, move that primitive down rather than introducing a cycle.

**Verify**: use a small AST/import test to assert foundational modules do not import `*_commands`, `parser`, `wizard_commands`, or `cli`.

### Step 4: Replace wildcard imports in command modules

For each command module, explicitly import only used symbols. Prefer module-qualified imports for broad service APIs, e.g. `state.load()` or `compose.command()`, when that makes origin clear. Keep command callback names stable.

Update test patch targets to where a symbol is looked up by the caller, not automatically where originally defined. Tests should continue asserting behavior, not implementation layout, except source-invariant tests.

**Verify**: `rg -n 'from vibeops\..* import \*' vibeops tests` reports no matches outside intentionally documented examples (prefer zero).

### Step 5: Replace parser/commands wildcard wiring

Choose one explicit callback wiring approach:

- `parser.py` imports named command modules and uses qualified callbacks (`app_commands.cmd_app_create`), or
- imports an explicit callback registry from `commands.py`.

Prefer qualified modules because parser construction clearly reveals ownership. Convert `commands.py` into either:

- a small explicitly named compatibility export surface with a removal note, or
- remove it if no supported external consumer exists and repository tests prove no use.

Do not guess external API compatibility. Since this is an operations repository rather than a published package, inspect README/docs before deciding. Preserve `from vibeops.commands import StackError` in `cli.py` only if `commands.py` intentionally remains; otherwise import from `errors.py`.

**Verify**: parser builds, all help commands work, and every subparser callback is callable.

### Step 6: Tighten static checks

Remove temporary Ruff ignores for `F403`/`F405` from Plan 001. Enable import-related/undefined-name checks that are now reliable. Do not add a formatter-only mega-diff.

Add source invariants:

- no wildcard imports;
- no bare Docker Compose literals outside `compose.py`;
- foundational modules do not import command layers;
- no module exceeds an agreed review threshold without an explicit rationale. Use 400 lines as a warning, not a brittle failure, unless the final module map supports a stricter bound.

**Verify**: `ruff check .`, source invariants, and `make check` pass.

### Step 7: Document the module map

Update `docs/architecture.md` with a concise management-package dependency map and rules:

- where new validation/state/render/service code belongs;
- parser/wizard are adapters, not business logic;
- Compose calls use `compose.py`;
- state writes use `state.py` transaction;
- generated writes use rendering transaction;
- no wildcard imports.

**Verify**: docs mention each final module and match actual imports.

## Test plan

This plan should add few new behavioral tests; it consumes the suite built by prior plans. Add only:

- parser callback completeness;
- import-cycle/layer invariants;
- wildcard/bare-Compose source invariants;
- import-all-modules smoke.

Run `make check` after every extraction commit. If Docker CI exists, ensure no command argv or generated output changes unexpectedly.

## Done criteria

- [ ] `rg -n 'import \*' vibeops tests` returns no matches.
- [ ] `helpers.py` is removed or reduced to an explicitly deprecated compatibility shim under roughly 100 lines with no business logic.
- [ ] Parser callback ownership is explicit.
- [ ] Foundational modules do not import command/parser/wizard layers.
- [ ] Compose, state, and render transaction ownership each have one module.
- [ ] Ruff wildcard ignores are removed.
- [ ] CLI help/output, state format, generated output, and command behavior remain unchanged.
- [ ] `make check`, Ruff, and CI pass.
- [ ] Plan 011 is marked DONE.

## STOP conditions

- Any prerequisite plan is not DONE or its tests are failing.
- A move changes generated bytes, command argv, state JSON, or user-visible output without an explicit reason.
- A circular import cannot be resolved without moving business logic across the target dependency direction.
- `vibeops.commands` is documented as a stable external API used outside the repository.
- The refactor starts requiring a framework/runtime dependency.

## Maintenance notes

The goal is comprehensible ownership, not the maximum number of files. Reject tiny modules that only rename a function without creating a clean dependency boundary. Review each commit for behavior-only diffs in tests and keep compatibility shims explicit and scheduled for removal.
