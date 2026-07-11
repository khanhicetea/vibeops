# Plan 007: Replace stale VibeOps skill, runbook, and deploy check

> **Executor instructions**: Treat `README.md` and `docs/architecture.md` after prerequisite plans as canonical. Do not preserve obsolete paths for compatibility. Run the deploy check from the repository root before marking DONE.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- .pi/skills/vibeops README.md docs/architecture.md docs/customization.md compose.yml vibeops`
> Plans 005 and 006 intentionally change render/apply and Compose behavior. Read their final code/docs before rewriting the skill.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/005-transactional-render-apply.md`, `plans/006-unify-compose-context.md`
- **Category**: docs / dx
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

The repository-specific agent skill still describes deleted `scripts/`, `nginx/`, `php/`, and `home/` layouts. Its deploy checker requires obsolete directories, so it cannot identify the current repository root. Agents following it will invoke nonexistent commands and may bypass the state/render/apply architecture.

## Current state

```markdown
# .pi/skills/vibeops/SKILL.md:12-24
files should include compose.yml, README.md, scripts/create-site.sh, nginx/, php/, home/.
...
- scripts/create-user.sh
- scripts/create-site.sh
...
.pi/skills/vibeops/scripts/deploy-check.sh
```

```bash
# .pi/skills/vibeops/scripts/deploy-check.sh:8-43
if [[ -f "$dir/compose.yml" && -d "$dir/scripts" && -d "$dir/nginx" ]]; then
...
for path in ... scripts/create-user.sh ... nginx/nginx.conf ...
```

The current architecture uses `manage.py`, `vibeops/`, `config/`, and `runtime/` (`docs/architecture.md:5-34`). Current app roots are `runtime/home/<app>/www`, not `home/<user>/<domain>`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Bash syntax | `bash -n .pi/skills/vibeops/scripts/deploy-check.sh` | exit 0 |
| Stale path audit | `rg -n 'scripts/create-|nginx/conf\.d|home/<user>/<domain>|php/<version>/users\.d' .pi/skills/vibeops` | no matches except an explicitly labeled legacy-migration note, preferably none |
| Deploy check | `.pi/skills/vibeops/scripts/deploy-check.sh` | recognizes root and exits 0 without Docker; warnings are allowed |
| Full gate | `make check` | exit 0 |

## Scope

**In scope**:

- `.pi/skills/vibeops/SKILL.md`
- `.pi/skills/vibeops/references/deploy-runbook.md`
- `.pi/skills/vibeops/scripts/deploy-check.sh`
- A focused static test under `tests/` if Plan 001's harness supports it

**Out of scope**:

- Changing production CLI/config behavior
- Duplicating the entire README into the skill
- Deployment mutations or starting Docker services
- Reintroducing removed compatibility scripts
- Host bootstrap/Ansible guidance not present in this repository

## Git workflow

- Branch: `advisor/007-refresh-skill`
- Commit message: `refresh vibeops operations skill`.
- Do not push.

## Steps

### Step 1: Rewrite skill first steps and mental model

Update `SKILL.md` to use current paths and commands:

- Root markers: `compose.yml`, `manage.py`, `vibeops/`, `config/`, `runtime/`, `README.md`.
- Canonical sources: README, architecture, customization guide, compose file, command module being changed, and relevant templates.
- App unit: app slug at `runtime/home/<app>/www`.
- Desired state: `runtime/state/stack.json`.
- Generated config: `runtime/generated`, never edited directly.
- Local customization: ignored Compose overlays and `runtime/custom` hooks.
- Render/apply transactional lifecycle from Plan 005.
- Common Compose context from Plan 006.
- Current commands for app/domain/proxy/TLS/cron/database/shell/identity/permissions.

Keep guardrails for host-network Nginx, socket mapping, MySQL/Redis isolation, TLS state, secrets, permissions, and validation. Remove every obsolete script command.

**Verify**: stale path audit passes.

### Step 2: Replace the runbook with current workflows

Rewrite `references/deploy-runbook.md` rather than patching scattered old names. It must include:

1. Current repository map.
2. Fresh clone bootstrap: `.env`, `./manage.py render`, Compose build/up, status.
3. App create, public-dir/front-controller, deploy with `exec`, database credentials location.
4. Domain and proxy workflows.
5. TLS ACME/files workflows.
6. Cron lifecycle and logs.
7. Identity/permission diagnosis.
8. Database backup/restore and recovery caveats.
9. Local customization and upstream update workflow.
10. Troubleshooting with current runtime paths and `./manage.py compose`.
11. Transactional render/apply rollback behavior and what to do after validation/reload failure.

Cross-link README/docs instead of copying long explanatory sections. Never include a real credential value.

**Verify**: every command beginning `./manage.py` parses through `./manage.py <top-level> --help` or is covered by an existing command smoke test.

### Step 3: Rebuild deploy-check as a read-only current-layout diagnostic

Update root detection. The check must:

- identify current root markers;
- never create `.env`, state, generated output, or service containers;
- validate required source files and template directories;
- check `.env` existence and placeholder password without printing values;
- run `python3 -B manage.py --help` and, if safe, a read-only state/path/status command;
- run Python AST and helper shell syntax checks or call `make check` only when doing so has no Docker/runtime mutation;
- inspect `./manage.py compose config -q` only if Docker and a usable environment exist; otherwise warn and continue;
- inspect running services/config only when already running;
- use current generated/socket/log paths;
- avoid fixed `php84/php85` loops where the CLI can enumerate configured versions;
- exit nonzero for missing source/invariant failures, but exit zero with warnings for absent Docker or `.env` on a development checkout.

Use temporary files via `mktemp` and clean them with `trap`. Do not write fixed `/tmp/vibeops.*` files.

**Verify**: run from root and from `.pi/skills/vibeops/`; both find the same root. With Docker absent, both exit 0 and report skipped Docker checks.

### Step 4: Add drift protection

Add a test that scans the skill/runbook/checker for removed path patterns and asserts current root markers/commands are present. If Plan 001 already has documentation smoke infrastructure, extend it; otherwise create `tests/test_skill_docs.py` with standard library only.

**Verify**: focused test and `make check` pass.

## Test plan

- Static obsolete-pattern rejection.
- Root discovery from two working directories.
- No-Docker execution path.
- Fake Docker failure path if practical by manipulating `PATH` in a temporary environment.
- Assert deploy-check does not modify `git status` when run twice.

## Done criteria

- [ ] No operational instruction references removed scripts/layout.
- [ ] Skill describes state, generated output, local overlays, and current permissions.
- [ ] Runbook covers all current top-level operational workflows.
- [ ] Deploy check recognizes the repository and is read-only.
- [ ] Deploy check works without Docker and does not expose `.env` values.
- [ ] Static tests and `make check` pass.
- [ ] Plan 007 is marked DONE.

## STOP conditions

- README and architecture disagree after Plans 005/006; report the contradiction instead of choosing silently.
- A useful check requires creating/updating runtime state.
- Root detection cannot be made unique with current source markers.
- A current CLI workflow cannot be verified from parser/help output.

## Maintenance notes

The repository skill is executable operational documentation. Whenever paths or command surfaces change, update it in the same PR and keep the stale-pattern test current. Prefer concise canonical links over duplicated prose that can drift again.
