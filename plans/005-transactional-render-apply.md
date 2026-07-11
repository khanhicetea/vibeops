# Plan 005: Make render and apply staged, validated, and rollback-safe

> **Executor instructions**: This is production-critical. Follow every step, preserve file modes, and stop on uncertainty. Do not replace the design with “delete and regenerate faster.” Update `plans/README.md` only after all failure-path tests pass.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/runtime_commands.py vibeops/helpers.py vibeops/template.py vibeops/app_commands.py vibeops/proxy_commands.py vibeops/cron_commands.py tests docs/architecture.md README.md`
> Plans 001–004 are expected to change tests, state locking, PHP resolution, and DB behavior. Reconcile current transaction boundaries before implementation.

## Status

- **Status**: DONE
- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-and-ci.md`, `plans/004-serialize-state-mutations.md`
- **Category**: bug / architecture
- **Planned at**: commit `84b3cfb`, 2026-07-11
- **Notes**: Implemented using existing `@serialized_cron_state` / cron lock (Plan 004 still broadens lock coverage). Transaction path: `apply_generated_config` in `runtime_commands.py`.

## Why this matters

Rendering currently deletes all live generated files before producing replacements. A malformed state record, missing template, disk error, or validation failure can leave bind-mounted Nginx/PHP/cron configuration incomplete, making the next reload or restart fail. Generation must complete in staging, then promote managed files safely, validate running services, and restore the previous generation on failure.

## Current state

```python
# vibeops/runtime_commands.py:109-124
def clean_generated_config():
    patterns = ["nginx/vhosts/*.conf", ...]
    for pattern in patterns:
        for path in GENERATED_DIR.glob(pattern):
            path.unlink(missing_ok=True)

def render_all(db):
    clean_generated_config()
    rendered = render_mysql_root_option_files()
```

```python
# vibeops/runtime_commands.py:188-209
def cmd_apply(args):
    db = load_db()
    rendered = render_all(db)
    save_db(db)
    ...
    run([..., "nginx", "nginx", "-t"])
    ...
    run([..., service, "php-fpm", "-tt"])
```

Most generated writers use `write_template()` → `write_text()` (`vibeops/helpers.py:276-283`, `:344-347`), while only selected secrets/cron aggregates use `write_text_atomic()` (`:286-299`, `:505-538`). TLS helpers also rewrite live vhosts directly (`vibeops/helpers.py:854-880`).

Architecture constraints:

- `runtime/state/stack.json` is desired state.
- `runtime/generated/` is disposable but is mounted live into containers.
- Preserve generated notice headers and file modes.
- The source directories themselves are bind-mounted; do not rename/swap the top-level mounted directory because a running container may continue seeing the old inode.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_render_transaction` | all pass |
| Full gate | `make check` | exit 0 |
| Compose smoke | `make compose-check` | exit 0 when Docker is available |

## Scope

**In scope**:

- `vibeops/runtime_commands.py`
- Generated-output functions in `vibeops/helpers.py`, `app_commands.py`, `proxy_commands.py`, and `cron_commands.py`
- `vibeops/template.py` only if rendering needs a pure content API
- `tests/test_render_transaction.py` (create)
- Existing render tests
- `docs/architecture.md`
- `README.md`

**Out of scope**:

- Renaming `runtime/generated/`
- State concurrency, already Plan 004
- Compose fragment routing, Plan 006
- Database dump transactions
- Replacing JSON state or the template language
- Automatically rolling back external MySQL user/database operations

## Git workflow

- Branch: `advisor/005-transactional-render`
- Use logical commits such as `stage generated config`, `add apply rollback`, `document render lifecycle`.
- Do not push.

## Steps

### Step 1: Introduce an explicit render target/context

Create a small typed path/context object (location may be `vibeops/runtime_commands.py` initially; Plan 011 will relocate it) that derives all generated destinations from a supplied root:

- Nginx vhosts
- PHP version users/pools
- cron job/combined/logrotate files
- MySQL protected option files, staged in a separate mode-700 secrets staging root

Update render functions to accept this context rather than silently writing global live constants. Default context may point at live paths for narrow command compatibility, but `render_all()` must always use a staging context.

Do not monkey-patch module globals in production. Tests may inject a context directly.

**Verify**: a unit test renders an empty state to a temporary root and asserts no file under repository `runtime/generated` or `runtime/secrets` changed.

### Step 2: Render a complete candidate generation in staging

Replace delete-first behavior with:

1. Create a mode-700 temporary transaction directory under `runtime/` so source and destination are on the same filesystem.
2. Render all candidate files into staging.
3. Validate all state values and templates during staging.
4. Build an explicit manifest of managed relative paths, file mode, and sensitivity.
5. Confirm every staged path remains under its allowed staging root and contains a generated header where applicable.
6. Only after complete success begin promotion.

Staging cleanup must run in `finally`. Never log secret contents. Do not include `.gitkeep` in the managed manifest.

**Verify**: inject a missing template/invalid cron halfway through render; assert live files and their byte content/modes remain unchanged and staging is removed.

### Step 3: Promote per file atomically and remove stale files last

Because container bind mounts point at existing directories, keep directories stable. For each managed candidate:

- snapshot the previous file bytes and mode into the transaction backup area if it exists;
- copy candidate content to a temporary file in the destination directory;
- `fsync`, `chmod`, and `os.replace` the destination;
- record the promotion in a journal/ordered list.

After every candidate is promoted, remove stale files that match only VibeOps-managed patterns and are absent from the candidate manifest. Snapshot stale files before removal. Never remove unknown local files lacking the generated notice, even if they match an extension; report them as unmanaged.

If any promotion/removal fails, restore all prior files in reverse order using atomic replacement, restore modes, and remove newly created files.

Preserve mode 600 for MySQL option files and mode 644 for generated service configuration.

**Verify**: fault-injection test fails on the Nth promotion and proves the complete live tree (content and modes) matches the pre-transaction snapshot.

### Step 4: Validate and rollback `apply`

`render` should stage and promote a syntactically complete candidate but does not reload services. `apply` must:

1. Hold the Plan 004 state transaction.
2. Stage and promote while retaining the backup until validation finishes.
3. If Nginx is running, run `nginx -t` against the promoted mounted files.
4. Group apps by PHP version, synchronize identities, and run `php-fpm -tt` for every running affected PHP service.
5. Run `supercronic -test` for every running/validatable cron version.
6. On any validation failure, restore the previous generation before returning an error; do not signal any reload.
7. Only after every validation passes, reload Nginx/PHP/cron.
8. Save normalized desired state and finalize/remove the transaction backup.

If a reload signal fails after validation, report the service failure. Do not roll generated files back after one service may already have loaded the new generation; instead leave the validated desired generation and provide an actionable retry. Document this boundary.

**Verify**: mocked tests prove validation order, no reload before all validations pass, and rollback on each validator failure.

### Step 5: Route direct vhost/TLS mutations through the transaction

App/domain/proxy/TLS commands currently render or patch one live vhost. Refactor them to update desired state and invoke the same targeted/full render transaction rather than editing generated files independently. TLS mode must remain in state and be rendered from templates; `replace_tls_block()` should not be the authoritative mutation path.

A command with `--no-reload` still stages/promotes generated output but skips service signals. It must not skip validation that can be performed safely without a running service.

**Verify**: tests modify TLS/domain state, force render failure, and assert both desired state and live vhost remain at the previous coherent generation.

### Step 6: Add transaction recovery diagnostics

If the process is killed, a leftover transaction directory may remain. On the next render/apply:

- detect abandoned transaction metadata;
- never silently delete a transaction marked as mid-promotion;
- fail with a message naming the safe recovery command or automatically restore only when the journal proves restoration is deterministic;
- provide a `render` retry path after recovery.

Do not build a general migration framework. Keep journal format local and versioned.

**Verify**: construct an interrupted journal fixture in a temp runtime root and test deterministic detection/recovery behavior.

### Step 7: Document the lifecycle

Update architecture and README:

```text
state lock -> stage complete generation -> atomic per-file promotion -> validate all -> reload -> finalize
                                                    \-> rollback on failure
```

Explain that top-level bind-mounted directories are stable, stale generated files are removed only after candidate generation succeeds, and reload failure after successful validation is retriable rather than rolled back.

**Verify**: documentation includes `stage`, `validate`, `rollback`, and `reload` in the render/apply section.

## Test plan

Create `tests/test_render_transaction.py` with temporary roots and deterministic fault injection. Required cases:

- successful empty and multi-app render;
- generation failure before promotion;
- failure on first/middle/final promotion;
- stale generated-file removal after success only;
- unknown/unmanaged file preservation;
- secret mode preservation;
- Nginx/PHP/cron validation failure rollback;
- no reload until all validators pass;
- abandoned transaction detection;
- TLS/domain command coherence.

Use existing template/cron tests as style references. No test may touch repository runtime paths.

## Done criteria

- [x] `clean_generated_config()` and delete-before-render behavior are gone.
- [x] Full candidate generation completes outside live paths.
- [x] File promotion is atomic per file and rollback restores bytes/modes.
- [x] Stale files are removed only after all candidates exist.
- [x] `apply` validates all affected services before any reload.
- [x] Direct app/proxy/TLS generated mutations use the transaction path.
- [x] Failure-path tests and unit suite pass (`tests.test_render_transaction`).
- [ ] `make check` / `make compose-check` when Plan 001 Makefile lands / Docker available.
- [x] Plan 005 is marked DONE.

## STOP conditions

- The implementation requires renaming a live bind-mounted source directory.
- A generated file cannot be rendered to an injected target without pervasive unrelated refactoring; report the exact call graph.
- Docker validation mutates or starts production services.
- Rollback cannot preserve a protected option file's mode.
- Existing generated directories contain user-owned files indistinguishable from VibeOps-managed output.
- State save and generated promotion cannot remain under the Plan 004 lock.

## Maintenance notes

Reviewers should focus on failure paths, not only successful rendering. Every new generated artifact must join the manifest with an explicit mode and managed marker policy. Keep transaction staging on the same filesystem as runtime destinations so `os.replace` remains atomic.
