# Plan 008: Make MySQL backups atomic and restores streaming

> **Executor instructions**: Never use a live database or real backup in tests. Preserve protected option-file authentication and avoid credential output. Update the plan index after failure-path tests pass.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/db_commands.py vibeops/helpers.py vibeops/compose.py tests README.md docs/architecture.md`
> Plan 006 changes all Compose argv construction; use its final API rather than adding bare Docker calls.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-establish-verification-and-ci.md`, `plans/006-unify-compose-context.md`
- **Category**: bug / perf
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

A failed `mysqldump` leaves any non-empty partial `.sql` file in the normal backup listing. Backup filenames have only second precision and are opened with truncation, so concurrent/repeated runs can overwrite. Restore reads the entire SQL dump into Python memory before piping it to MySQL, which scales poorly for production-sized data.

## Current state

```python
# vibeops/db_commands.py:25-26
def _stamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")

# vibeops/db_commands.py:52-58
with output_path.open("w") as fh:
    cp = subprocess.run(cmd, stdout=fh, ...)
if cp.returncode != 0:
    if output_path.exists() and output_path.stat().st_size == 0:
        output_path.unlink()
```

```python
# vibeops/db_commands.py:226-230
sql = path.read_text(encoding="utf-8")
if not sql.strip(): ...
mysql_root_exec_sql(sql, service=service)
```

Backup listings and retention glob every `*.sql` file (`vibeops/db_commands.py:172-198`). Authentication uses `/run/secrets/vibeops-root.cnf`; preserve it.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_db_backup_restore` | all pass |
| Full gate | `make check` | exit 0 |
| Bare Compose audit | `rg -n '"docker", "compose"' vibeops/db_commands.py` | no matches |

## Scope

**In scope**:

- `vibeops/db_commands.py`
- A narrow streaming subprocess helper in `vibeops/helpers.py` or Plan 006's process/Compose module
- `tests/test_db_backup_restore.py` (create)
- `README.md` database backup section
- `docs/architecture.md` recovery notes if semantics change

**Out of scope**:

- Compression/encryption/offsite upload
- PITR/binlog policy
- Physical MySQL backups
- Scheduling backups automatically
- Changing SQL grant behavior
- Restoring into a new database name

## Git workflow

- Branch: `advisor/008-atomic-backups`
- Commit message: `harden mysql backup restore`.
- Do not push.

## Steps

### Step 1: Generate collision-resistant final names

Keep human-sortable timestamps but include microseconds or an additional secure short suffix. Before dumping, reserve a unique final name without truncating an existing backup. Never overwrite a final `.sql` file.

Use one timestamp per backup batch, but ensure per-database names and repeated batches remain unique. Validate database names as currently done.

**Verify**: a unit test requests multiple names at the same mocked time and receives distinct paths; pre-existing final file content is unchanged.

### Step 2: Dump into a private partial file and promote atomically

For each database:

1. Ensure backup dir mode 700.
2. Create a unique mode-600 partial file in the same backup directory with a suffix not matched by `*.sql` (for example `.sql.partial-<token>`).
3. Stream `mysqldump` stdout directly into it.
4. On process success, flush and `fsync`, verify non-empty output, then `os.replace` to the reserved final `.sql` path and fsync the directory where supported.
5. On any exception/nonzero/empty output, remove the partial file and leave no final file.

Capture bounded stderr for diagnostics; do not capture dump stdout in memory. Do not include passwords in argv.

**Verify**: mocked success promotes exact content/mode; mocked nonzero after writing partial bytes leaves no `*.sql` and no partial file.

### Step 3: Stream restore input

Replace `path.read_text()` with a streaming subprocess path:

- Reject missing, non-file, or zero-size input before starting MySQL.
- Open dump in binary mode.
- Start `docker compose ... exec -T <service> mysql --defaults-extra-file=... --batch --raw` using Plan 006's argv builder.
- Connect the file handle directly to subprocess stdin; do not pass `input=` and do not decode the SQL.
- Capture bounded stderr or inherit it; return a concise `StackError` on nonzero.
- Always close handles.

A SQL file may contain bytes not decodable as UTF-8; streaming binary mode should preserve them.

**Verify**: test with a multi-megabyte/non-UTF-8 fixture and assert no `Path.read_text` call and exact streamed bytes at the mocked process boundary.

### Step 4: Harden listing and retention

Listings and retention must include only finalized regular `*.sql` files. Ignore partials and symlinks. Validate `--keep` as nonnegative at argument/handler boundary; decide and document whether `--keep 0` intentionally removes all finalized backups. Prefer rejecting zero unless the destructive behavior is explicitly confirmed.

Apply retention only after all requested dumps in a batch succeed. If database N of M fails, keep earlier successful finalized dumps but do not run retention; report which files were safely written.

**Verify**: tests cover partial files, symlinks, keep boundary, and a mid-batch failure.

### Step 5: Document recovery semantics

Update README:

- final backups appear only after successful dump;
- partials are cleaned on ordinary failure;
- restore streams input and may overwrite objects;
- `--keep` exact semantics;
- regular off-box copies remain required.

Do not imply atomicity at the MySQL object level during restore.

**Verify**: backup docs include `atomic`, `partial`, and `stream` or equivalent precise terms.

## Test plan

Mock subprocess/Popen and use temporary backup directories. Required cases:

- successful dump;
- nonzero dump with non-empty partial;
- empty successful stdout treated as failure;
- final-name collision;
- multiple database batch;
- retention after success only;
- streaming large/non-UTF-8 restore;
- restore nonzero error;
- no credentials in argv/logs.

## Done criteria

- [ ] Failed/empty dumps leave no final `.sql` file.
- [ ] Existing backups are never truncated.
- [ ] Final promotion is same-filesystem atomic.
- [ ] Restore does not load full SQL into Python memory.
- [ ] Partial files are excluded from listing/retention.
- [ ] All DB subprocesses use Plan 006 Compose context.
- [ ] Focused tests and `make check` pass.
- [ ] Plan 008 is marked DONE.

## STOP conditions

- Docker Compose/Python subprocess APIs cannot stream stdin while preserving required behavior.
- Existing backups rely on symlink handling.
- Current production filenames are parsed by external tooling and a format change needs compatibility design.
- Atomic promotion cannot occur on the same filesystem.

## Maintenance notes

Future compression or encryption should remain a streaming pipeline and preserve the partial-to-final promotion rule. Reviewers should inject failures after bytes are written; a test that fails before opening the output would miss the original bug.
