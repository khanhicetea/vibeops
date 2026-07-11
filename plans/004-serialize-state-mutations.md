# Plan 004: Serialize every desired-state read-modify-write transaction

> **Executor instructions**: Execute in order, verify each step, and stop rather than narrowing lock coverage to make tests pass. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/helpers.py vibeops/app_commands.py vibeops/db_commands.py vibeops/proxy_commands.py vibeops/cron_commands.py vibeops/tls_commands.py vibeops/runtime_commands.py tests`
> Plans 001–003 intentionally change tests, PHP resolution, and database creation. Compare live symbols before applying this plan.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-and-ci.md`, `plans/002-resolve-app-php-version.md`, `plans/003-record-database-success.md`
- **Category**: bug / tech-debt
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

`save_db()` atomically replaces the JSON file, but atomic replacement does not prevent lost updates: two processes can load the same state, make different changes, and the last save wins. UID allocation can also race. Only cron/render currently use a `.cron.lock`, even though app, domain, proxy, TLS, database, and state-init commands mutate the same source of truth.

## Current state

```python
# vibeops/helpers.py:233-259
def load_db():
    ...

def save_db(data):
    ...
    os.replace(tmp_name, DB_PATH)
```

```python
# vibeops/helpers.py:302-321
@contextmanager
def cron_state_lock():
    lock_path = STATE_DIR / ".cron.lock"
    ...
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)

def serialized_cron_state(func):
    with cron_state_lock():
        return func(...)
```

Cron handlers use the lock (`vibeops/cron_commands.py:92-137`, `:159-188`), and render/apply use its decorator (`vibeops/runtime_commands.py:178-213`). App/domain/proxy/TLS/database mutations do not.

State vocabulary from `docs/architecture.md:20-38`: `runtime/state/stack.json` is desired state; `runtime/generated/` is disposable. Preserve atomic JSON replacement and schema normalization.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_state_locking` | all pass |
| Full gate | `make check` | exit 0 |
| Lock reference check | `rg -n "cron_state_lock|serialized_cron_state|\.cron\.lock" vibeops tests` | no production matches after migration |

## Scope

**In scope**:

- `vibeops/helpers.py`
- Mutating handlers in `vibeops/app_commands.py`, `db_commands.py`, `proxy_commands.py`, `cron_commands.py`, `tls_commands.py`, and `runtime_commands.py`
- `vibeops/permission_commands.py` only if a code path writes desired state (normally it should not)
- `tests/test_state_locking.py` (create)
- Existing tests requiring decorator-aware adjustments

**Out of scope**:

- Distributed/multi-host locking
- Locking Docker volumes, databases, or application code
- Transactional generated-file promotion (Plan 005)
- Async/threaded command execution
- Replacing JSON with SQLite

## Git workflow

- Branch: `advisor/004-state-transactions`
- Commit message: `serialize state mutations`.
- Do not push.

## Steps

### Step 1: Generalize the lock

Replace `cron_state_lock()` with `state_lock()` using `runtime/state/.state.lock`. Replace `serialized_cron_state` with a general decorator only if decorators remain the clearest usage.

Requirements:

- Exclusive advisory `fcntl.flock` on Linux/macOS.
- Exception-safe release.
- Reentrant within one CLI process, because a decorated handler may call a helper that also needs transaction protection. Implement explicit process-local depth tracking or design one non-nested transaction boundary; do not rely on uncertain behavior from opening the same lock file twice.
- Lock descriptor must not leak through `os.execvp` into long-running Docker/shell processes. Python descriptors should be non-inheritable, but assert/set this explicitly.
- Lock file content contains no secrets.

Keep atomic `os.replace` in `save_db()`.

**Verify**: unit tests acquire nested `state_lock()` contexts in one process without deadlock and release after an exception.

### Step 2: Define mutation boundaries

Inventory every `save_db()` call. Ensure the exclusive lock covers the entire sequence from `load_db()` through validation, in-memory mutation, generated-file changes directly tied to that mutation, and `save_db()`.

At minimum cover:

- app creation and domain changes;
- deprecated user/site writes while they remain;
- app/database metadata updates and password-reset metadata;
- proxy create;
- cron create/remove;
- TLS mode updates;
- render/apply state normalization saves;
- state init/migrate.

Read-only commands (`list`, `show`, `status`, selection prompts) should not take an exclusive lock unless they invoke a mutating handler. Do not hold a lock while waiting for interactive user input; prompts and confirmation happen first, then the command handler locks and revalidates against fresh state.

**Verify**: `rg -n "save_db\(" vibeops` and inspect every match; each must be lexically inside or called under `state_lock()`.

### Step 3: Avoid stale wizard selections

Wizard flows often load state, prompt, then call command handlers. The handler must reload state under lock and revalidate selected app/domain/cron identity. Do not pass a stale mutable DB object from the wizard into a transaction.

If a numbered selection disappeared or changed before lock acquisition, emit `StackError` with a retry instruction instead of acting on a different item.

**Verify**: mocked test changes state between selection and command execution and asserts no wrong record is modified.

### Step 4: Protect UID allocation and schema initialization

Ensure `allocate_uid()` runs while the state lock is held when creating an identity. Validate explicit UIDs against current state and generated identity metadata under the same lock; fail clearly on duplicate UID/GID before Docker helper execution.

`state init --force` and `state migrate --force` must also lock. Legacy-file rename and new-state save should be within the same transaction and preserve recovery behavior.

**Verify**: tests launch two processes against a temporary state root, each creating a distinct synthetic record/UID; both records survive and allocated UIDs differ.

### Step 5: Add concurrency and failure tests

Create `tests/test_state_locking.py`. Use `tempfile.TemporaryDirectory`, `multiprocessing`, and patched path constants or a supported test path injection. Cover:

1. Two writers serialize and both updates survive when each reloads under lock.
2. Nested lock use does not deadlock.
3. Exception releases the lock.
4. Atomic save leaves parseable JSON.
5. Duplicate explicit UID is rejected before external command execution.
6. Read-only load remains available without an exclusive writer transaction where safe.

Use timeouts on multiprocessing joins so a deadlock fails deterministically.

**Verify**: focused tests complete within five seconds and `make check` passes.

## Test plan

Concurrency tests must use separate OS processes; thread-only tests do not prove `flock` behavior. Never point them at repository `runtime/state`. Add a guard asserting the temporary DB path is outside the repository before writing.

## Done criteria

- [ ] No `.cron.lock`, `cron_state_lock`, or `serialized_cron_state` production references remain.
- [ ] Every desired-state read-modify-write is under `state_lock()`.
- [ ] No lock is held while waiting for interactive input or after `execvp`.
- [ ] Concurrent writer test proves no lost update and no duplicate auto UID.
- [ ] State remains atomically written and parseable.
- [ ] Focused tests and `make check` pass.
- [ ] Plan 004 is marked DONE.

## STOP conditions

- A command must hold the lock across a long-lived interactive shell or database client.
- Path injection for tests risks writing repository runtime state.
- A nested lock deadlocks and cannot be eliminated with a clear single boundary.
- Cross-host writers are a real supported deployment mode; `flock` is not sufficient and needs a separate design.
- Existing state contains duplicate UIDs that require operator migration policy.

## Maintenance notes

The invariant is broader than “writes are atomic”: every writer must load after acquiring the lock. Review new commands for this ordering. Keep the lock local to desired-state coordination; do not turn it into a global mutex around unrelated Docker reads.
