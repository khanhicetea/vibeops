# Plan 002: Add `proxy list` and `proxy remove`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- vibeops/commands/proxy_commands.py vibeops/commands/parser.py vibeops/commands/runtime_commands.py tests/test_reload_scope.py docs/architecture.md README.md`
> On mismatch with "Current state" excerpts, STOP and report.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (optional: reuse confirmation patterns from plan 001 if already merged)
- **Category**: direction / dx / feature
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

`proxy create` is one-way. Operators cannot list or remove reverse-proxy vhosts through the CLI even though `status` already prints proxies from `db["sites"]`. Completing list/remove removes hand-editing of `stack.json` and orphaned `runtime/generated/nginx/vhosts/<domain>.conf` files.

## Current state

- `vibeops/commands/proxy_commands.py` — only `render_proxy_vhost` and `cmd_proxy_create`:

```python
@serialized_cron_state
def cmd_proxy_create(args: argparse.Namespace) -> None:
    ...
    site = db["sites"].setdefault(main_domain, {})
    site.update({
        "type": "proxy",
        "domain": main_domain,
        "aliases": aliases,
        "upstream": upstream,
        "tls": site.get("tls", {"mode": "self-signed"}),
    })
    ...
    apply_generated_config(..., service_targets=SERVICE_TARGETS_NGINX)
    save_db(db)
```

- Parser (`vibeops/commands/parser.py` ~231–239): only `proxy create`
- Domain index: `db["domains"][domain] = {"kind": "proxy", "domain": main_domain}`
- Status already lists proxies (`cmd_status` filters `sites` with `type == "proxy"`)
- Reload: nginx-only (`SERVICE_TARGETS_NGINX`)

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Full gate | `make check` | exit 0 |
| Focused tests | `python3 -B -m unittest tests.test_proxy_lifecycle -v` | all pass |
| Help | `./manage.py proxy list --help` / `proxy remove --help` | exit 0 |

## Scope

**In scope**:
- `vibeops/commands/proxy_commands.py`
- `vibeops/commands/parser.py`
- `tests/test_proxy_lifecycle.py` (new)
- `tests/test_reload_scope.py` (add remove row if applicable)
- `docs/architecture.md` reload matrix
- `README.md` proxy section (if present; else brief note near proxy create)

**Out of scope**:
- App remove (plan 001)
- Changing TLS commands
- Upstream health checks

## Git workflow

- Branch: `advisor/002-proxy-list-remove`
- Commit message style: short imperative, e.g. `proxy list remove`
- Do not push unless asked

## Product behavior

```text
./manage.py proxy list
./manage.py proxy remove <domain> [--yes] [--no-reload]
# or: ./manage.py proxy remove --number N
```

1. **list**: table of proxies with selection numbers: `#`, domain, upstream, aliases (joined), TLS mode — use `vibeops/ui/table.py` `print_table` like `cron list` / `app domain list`
2. **remove**:
   - Resolve by domain or `--number` from list order (same pattern as `cron remove`)
   - Delete `db["sites"][main_domain]`
   - Delete all `db["domains"]` entries pointing at that proxy main domain
   - `apply_generated_config` with `SERVICE_TARGETS_NGINX` so generated conf is gone
   - `save_db`
   - Confirmation: TTY confirm or `--yes`; non-TTY requires `--yes`

## Steps

### Step 1: Tests

Write `tests/test_proxy_lifecycle.py`:

- list ordering stable
- remove clears sites + domains and calls apply with nginx-only targets
- unknown domain dies
- parser has list/remove

**Verify**: tests exist; implement until green.

### Step 2: Implement commands

Add `cmd_proxy_list` and `cmd_proxy_remove` in `proxy_commands.py`. Mirror create’s domain index maintenance (inverse of create’s domain upsert loop).

### Step 3: Parser

Wire under `proxy` subparsers after `create`.

### Step 4: Docs + reload matrix

Update architecture reload table: `proxy remove` → nginx only.

### Step 5: Gate

**Verify**: `make check`

## Test plan

- Happy path remove + list numbers
- Reload scope nginx-only
- Do not delete unrelated apps/sites

## Done criteria

- [ ] `proxy list` and `proxy remove` (alias `delete` optional) work
- [ ] `make check` passes
- [ ] Removing a proxy frees domains for re-use by `assert_domain_free`
- [ ] `plans/README.md` status → `DONE`

## STOP conditions

- Proxy records are not always keyed by main domain in `sites` — inspect real state and STOP if dual-key models appear
- Remove appears to require deleting ACME state under `runtime/nginx-acme-state/` — leave ACME state on disk; do not wipe cert cache in this plan

## Maintenance notes

- Symmetric with `proxy create`; keep TLS mode on remaining proxies untouched
- Future: `proxy update` for upstream without full recreate
