# Plan 002: Add non-Docker coverage and document the new permission workflow

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0da3fa3..HEAD -- .env.example README.md docs .pi/skills/vibeops vibeops/wizard_commands.py tests`
> Plan 001 is expected to have changed production identity/permission files.
> If its commands or interfaces differ from Plan 001's required design, stop
> before writing tests or documentation for a different interface.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-split-php-identity-and-permissions.md`
- **Category**: tests, docs, dx
- **Planned at**: commit `0da3fa3`, 2026-07-10

## Why this matters

The repository currently has no automated test suite, while the identity/permission refactor changes security-sensitive command construction and shell policy. The operator develops on macOS without Docker, so useful verification must run without building or starting containers. Documentation and the interactive wizard must also stop teaching the removed startup ownership behavior and expose the explicit repair workflow.

## Current state

- There is no `tests/` directory or project test configuration.
- `README.md:327-337` describes `FIX_HOME_OWNERSHIP` as the ownership mechanism.
- `.env.example:29-31` enables recursive startup repair by default.
- `docs/customization.md:269-277` tells operators to disable automatic repair for large trees but offers no first-class replacement command.
- `.pi/skills/vibeops/references/deploy-runbook.md:236-254` tells operators to invoke `php-user-sync` directly.
- `vibeops/wizard_commands.py` has guided operations for apps, domains, databases, cron, TLS, shell, and status, but not identity/permission diagnostics.

Plan 001's required public interface is:

```bash
./manage.py identity sync shop
./manage.py identity sync --all
./manage.py permissions check shop [--json]
./manage.py permissions check --all [--json]
./manage.py permissions fix shop [--recursive] [--dry-run] [--json]
./manage.py permissions fix --all [--recursive] [--dry-run] [--json]
```

Plan 001's security invariants are:

- app user/group are private and share the same numeric UID/GID;
- app users are not members of `nginxsock`;
- FPM socket group remains `nginxsock`;
- recursive filesystem work occurs only under explicit `permissions check/fix`, never startup/apply/exec;
- no migration or backward-compatible `php-user-sync` path exists.

Repository test constraints:

- Use Python standard-library `unittest`; do not introduce package dependencies.
- Use `python3 -B` so tests do not write `__pycache__` in the working tree.
- Do not run Docker locally.
- Temporary generated files belong under `tempfile.TemporaryDirectory`, never `runtime/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full tests | `python3 -B -m unittest discover -s tests -v` | exit 0, all tests pass |
| Shell syntax | `sh -n docker/php/bin/php-identity-sync docker/php/bin/php-permissions docker/php/bin/php-app-run docker/php/bin/php-cron-as docker/php/bin/php-supercronic` | exit 0 |
| CLI smoke | `python3 -B manage.py permissions fix --help && python3 -B manage.py identity sync --help` | exit 0 |
| Stale docs | `rg -n 'php-user-sync|FIX_HOME_OWNERSHIP|automatic recursive ownership' README.md docs .env.example .pi/skills/vibeops` | no matches |

## Scope

**In scope**:

- `tests/__init__.py` (create)
- `tests/test_identity_rendering.py` (create)
- `tests/test_permission_cli.py` (create)
- `tests/test_shell_helpers.py` (create)
- `tests/test_source_invariants.py` (create)
- `vibeops/wizard_commands.py`
- `.env.example`
- `README.md`
- `docs/architecture.md`
- `docs/customization.md`
- `.pi/skills/vibeops/SKILL.md`
- `.pi/skills/vibeops/references/deploy-runbook.md`

**Out of scope**:

- Docker tests, image builds, Compose execution, or Linux-specific integration tests.
- Further production refactoring outside `vibeops/wizard_commands.py`; production defects discovered by tests must be reported back to Plan 001's executor instead of silently expanding this scope.
- Migration or backward-compatibility documentation.
- New test dependencies, CI providers, Makefiles, or packaging configuration.
- Changes to Nginx, MySQL, Redis, TLS, or application deployment behavior.

## Git workflow

- Branch: `advisor/002-permission-tests-docs`
- Use logical commits in the repository's short imperative style, for example `test and document permission commands`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add parser, selection, and command-construction tests

Create `tests/test_permission_cli.py` using `unittest` and `unittest.mock`.

Cover at least these cases:

1. Parser accepts one-app identity sync.
2. Parser accepts `identity sync --all`.
3. Parser accepts permission check/fix flags exactly as documented.
4. Handler rejects neither-app-nor-`--all` and rejects app plus `--all`.
5. Handler rejects `--php` with `--all`.
6. Unknown app raises `StackError` with the app name.
7. One-app operation derives PHP version from state.
8. Explicit `--php` overrides only a one-app identity sync.
9. All-app identity sync groups app names by PHP version and emits one helper invocation per version.
10. Running FPM uses `docker compose exec -T`.
11. Stopped FPM uses `docker compose run --rm --entrypoint ... phpXX-cli`.
12. Permission fix forwards `--recursive` and `--dry-run` but does not add either flag when absent.
13. Single-app JSON parses helper output and emits one valid JSON object.
14. Multi-app JSON emits one valid JSON array, even when apps span PHP versions.
15. A dirty `permissions check --all` continues checking remaining apps and ultimately returns/raises a non-zero result according to the implementation's command-handler convention.

Patch globals in `vibeops.permission_commands`, not broad `subprocess` internals. Use a small state fixture with apps on both PHP 8.4 and 8.5. Assert complete argv lists so argument ordering regressions are visible.

If Plan 001 implemented process exit propagation in a form difficult to unit test, make the smallest in-scope testability adjustment only if it is inside `vibeops/wizard_commands.py`; otherwise stop and send the issue back to Plan 001.

**Verify**: `python3 -B -m unittest tests.test_permission_cli -v`

Expected: all tests pass without Docker calls.

### Step 2: Test generated identity metadata and private FPM groups

Create `tests/test_identity_rendering.py`.

Use `tempfile.TemporaryDirectory` and patch path constants in `vibeops.helpers` so no test writes under `runtime/`. Cover:

- Rendered user env contains `USERNAME`, equal numeric `UID`/`GID`, and normalized `PUBLIC_DIR`.
- Empty public directory renders `PUBLIC_DIR=`.
- A nested safe public directory such as `web/public` is preserved.
- Traversal public directories are rejected before rendering.
- Generated pool uses `group = <app>` and retains `listen.group = nginxsock`.
- Re-rendering from state produces the same identity metadata.

If directly exercising `render_app_identity` requires too many unrelated runtime paths, test the narrow rendering function introduced by Plan 001. Do not weaken assertions to string-presence-only if a callable rendering path exists.

**Verify**: `python3 -B -m unittest tests.test_identity_rendering -v`

Expected: all tests pass and `git status --short runtime` shows no test-created files.

### Step 3: Test shell interfaces without root or Docker

Create `tests/test_shell_helpers.py` using `subprocess.run`, temporary directories, and environment overrides.

Cover only behavior that is safe on macOS/non-root:

1. `sh -n` succeeds for every PHP shell helper.
2. Every new helper's missing/invalid arguments return the documented usage error without mutation.
3. `php-permissions` rejects a missing env file.
4. `php-permissions` rejects absolute and `..` `PUBLIC_DIR` values before invoking identity commands.
5. `php-permissions fix --dry-run` on a valid temporary home reports intended operations but leaves modes, ownership, and an external symlink target unchanged.
6. `php-permissions --json` error/safe-check paths keep stdout parseable as JSON when the interface promises JSON.
7. `php-app-run` with missing arguments exits with usage status and does not attempt identity synchronization.

Use `PHP_USERS_DIR`, `PHP_HOME_ROOT`, and other testability environment variables required by Plan 001. Do not fake success for `useradd`, `groupadd`, `chown`, or `chmod`; root identity behavior is explicitly not tested on macOS.

**Verify**: `python3 -B -m unittest tests.test_shell_helpers -v`

Expected: all tests pass without Docker/root access and temporary paths are removed.

### Step 4: Add source-level regression invariants

Create `tests/test_source_invariants.py`. These tests should read tracked source files relative to the repository root and assert:

- `compose.yml` contains no `php-user-sync` or `FIX_HOME_OWNERSHIP`.
- FPM and cron startup contain `php-identity-sync` but not `php-permissions`.
- CLI services use `php-app-run` and do not run all-user identity sync.
- Pool template process group is `${USERNAME}` while `listen.group` is `${SOCKET_GROUP_NAME}`.
- No production Python/shell/config file references `php-user-sync`.
- Recursive `chown`/`find` under `/home` exists only in `docker/php/bin/php-permissions`.
- `cmd_apply` source or mocked behavior establishes identity sync before `php-fpm -tt`.
- `cmd_app_exec` does not synchronize the separate running FPM container.

Prefer behavioral mock assertions where practical. Use source assertions only for cross-file security invariants that would otherwise require Docker.

**Verify**: `python3 -B -m unittest tests.test_source_invariants -v`

Expected: all tests pass.

### Step 5: Add wizard permission operations

Update `vibeops/wizard_commands.py` to import the new handlers and add two guided actions:

- `Check app permissions`
- `Fix app permissions`

Both select an app using `wizard_select_app`. Check previews and executes the equivalent non-JSON CLI operation. Fix asks whether to repair recursively (default false), always shows the equivalent CLI command, prints a plan, and requires confirmation defaulting to false because recursive ownership/mode changes are destructive. Do not expose identity sync in the wizard; it is an advanced troubleshooting operation and already available in CLI.

Match existing `print_plan`, `prompt_confirm`, `argparse.Namespace`, and equivalent-command conventions.

Add parser/handler delegation tests to `tests/test_permission_cli.py` only if they can avoid interactive input complexity. Otherwise test the wizard helper by patching `wizard_select_app`, `prompt_confirm`, and the command callback.

**Verify**:

```bash
python3 -B -m unittest tests.test_permission_cli -v
python3 -B -c 'from vibeops.wizard_commands import cmd_wizard'
```

Expected: tests and import pass.

### Step 6: Replace old environment and ownership documentation

Update `.env.example`:

- Keep `SOCKET_GID` explanation.
- Remove `FIX_HOME_OWNERSHIP` entirely.
- Explain briefly that startup syncs identities only and permission repair is explicit.

Update `README.md` with:

- App-private UID/GID and shared socket group model.
- FPM worker group vs socket group distinction.
- The `identity sync` troubleshooting command.
- `permissions check/fix`, `--all`, `--recursive`, `--dry-run`, and `--json` examples.
- A warning that recursive repair is explicit and may scan large trees.
- Deployment guidance that `manage.py exec/shell` creates files as the app user and public directories use inherited Nginx-readable group policy.
- Removal of all advice about `FIX_HOME_OWNERSHIP`.

Update `docs/architecture.md` to document separate identity and permission planes and lifecycle ordering:

```text
render -> identity sync -> php-fpm -tt -> reload
```

Update `docs/customization.md` so the ownership section describes desired state versus generated identity metadata and uses first-class commands rather than environment toggles/direct helper invocation.

Update `.pi/skills/vibeops/SKILL.md` guardrails and `.pi/skills/vibeops/references/deploy-runbook.md` troubleshooting commands. The runbook should use:

```bash
./manage.py identity sync appuser --php 8.5
./manage.py permissions check appuser
./manage.py permissions fix appuser --recursive --dry-run
./manage.py permissions fix appuser --recursive
```

Do not retain a compatibility note for `php-user-sync`; this is a new project and the old interface is removed.

**Verify**:

```bash
! rg -n 'php-user-sync|FIX_HOME_OWNERSHIP|automatic recursive ownership' README.md docs .env.example .pi/skills/vibeops
rg -n 'identity sync|permissions (check|fix)|private.*group|socket group' README.md docs .pi/skills/vibeops
```

Expected: stale terms have no matches; new concepts and commands are documented.

### Step 7: Run the complete non-Docker verification suite

Run:

```bash
python3 -B -m unittest discover -s tests -v
python3 -B manage.py --help
python3 -B manage.py identity sync --help
python3 -B manage.py permissions check --help
python3 -B manage.py permissions fix --help
sh -n docker/php/bin/php-identity-sync docker/php/bin/php-permissions docker/php/bin/php-app-run docker/php/bin/php-cron-as docker/php/bin/php-supercronic
rg -n 'php-user-sync|FIX_HOME_OWNERSHIP' . --glob '!.git/**' --glob '!plans/**'
git status --short
```

Expected:

- All tests pass.
- Help and shell syntax commands exit 0.
- Stale-term search returns no matches.
- Git status contains only Plan 001 files, this plan's in-scope files, and plan status updates.
- No Docker command is run.

## Test plan

This plan is the test plan. It establishes a one-command standard-library suite with four layers:

- parser/command argv tests;
- generated identity/FPM policy tests;
- safe non-root shell interface tests;
- source-level lifecycle/security invariants.

Linux container behavior intentionally remains an operator/CI follow-up. The suite must not claim to validate real `useradd`, `groupadd`, numeric bind-mount ownership, FPM socket access, or Nginx filesystem access.

## Done criteria

- [ ] `python3 -B -m unittest discover -s tests -v` passes without Docker/root.
- [ ] Tests cover command selection, argv construction, generated identity, shell validation, dry-run non-mutation, and lifecycle invariants.
- [ ] Wizard exposes check/fix with confirmation for recursive repair.
- [ ] README, architecture, customization guide, skill, and runbook describe the new model and exact commands.
- [ ] `.env.example` has no startup ownership-repair toggle.
- [ ] No source/docs outside `plans/` reference `php-user-sync` or `FIX_HOME_OWNERSHIP`.
- [ ] Documentation explicitly says Docker/Linux behavior was not tested locally.
- [ ] No files outside the in-scope list and `plans/README.md` are modified by this plan.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report rather than improvising if:

- Plan 001 did not implement the documented command names/flags or private-group model.
- A production defect requires changing files outside `vibeops/wizard_commands.py`; return it to Plan 001.
- A proposed test requires Docker, root, or writes to `runtime/`.
- Shell helpers do not expose test-safe path overrides or validate traversal before privileged operations.
- Documentation would need migration/backward-compatibility guidance; the operator explicitly said this is a new project.
- The full test suite fails twice after a reasonable correction.

## Maintenance notes

- Keep the test suite dependency-free unless the repository later adopts a Python project/test toolchain.
- Source-invariant tests are intentional guardrails for security-sensitive lifecycle behavior; update them only when the architecture changes deliberately.
- Real Linux verification remains valuable before production use: app A must not read app B, Nginx must read public files/open FPM sockets, and repeated restarts must not traverse homes. It is deferred because the operator explicitly requested no Docker testing on this macOS environment.
