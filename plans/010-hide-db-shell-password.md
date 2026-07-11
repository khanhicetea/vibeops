# Plan 010: Remove app database passwords from host command arguments

> **Executor instructions**: Never print or commit a credential while implementing or testing. Use fake sentinel values in tests and assert they are absent from argv/errors. Update the plan index when complete.
>
> **Drift check (run first)**: `git diff --stat 84b3cfb..HEAD -- vibeops/db_commands.py vibeops/helpers.py vibeops/compose.py tests README.md`
> Plan 006 changes Compose argv construction; use its final command builder.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-establish-verification-and-ci.md`, `plans/006-unify-compose-context.md`
- **Category**: security
- **Planned at**: commit `84b3cfb`, 2026-07-11

## Why this matters

`db shell --user` embeds the app password in the host `docker compose` command's `-e MYSQL_PWD=<value>` argument. Process inspection, command telemetry, or wrapper diagnostics can capture it. The interactive client must receive credentials without putting their value in host argv or logs.

## Current state

```python
# vibeops/db_commands.py:103-125
password = creds.get("MYSQL_PASSWORD") or creds.get("DB_PASSWORD")
...
subprocess.run([
    "docker", "compose", "exec",
    "-e", f"MYSQL_USER={username}",
    "-e", f"MYSQL_PWD={password}",
    service,
    "sh", "-lc",
    'mysql -u"$MYSQL_USER" -p"$MYSQL_PWD"',
])
```

Root shell already uses a protected mounted option file (`vibeops/db_commands.py:127-135`). App credential files are mode 600 under `runtime/home/<app>/.credentials/<service>.env` and are not currently mounted into MySQL containers.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Focused tests | `PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v tests.test_db_shell_security` | all pass |
| Source audit | `rg -n 'MYSQL_PWD|f"MYSQL_.*password|f"DB_.*password' vibeops` | no password-valued argv construction |
| Full gate | `make check` | exit 0 |

## Scope

**In scope**:

- `vibeops/db_commands.py`
- A narrow helper in `vibeops/helpers.py` or `vibeops/compose.py` if required
- `tests/test_db_shell_security.py` (create)
- README database-shell note

**Out of scope**:

- Changing stored app credential-file format
- Root MySQL option-file behavior
- Rotating existing credentials
- Docker daemon threat model
- Replacing the MySQL client
- Exposing credentials through environment-variable debug output

## Git workflow

- Branch: `advisor/010-db-shell-secret-transport`
- Commit message: `hide db shell password argv`.
- Do not push.

## Steps

### Step 1: Choose a no-argv credential transport

Implement one of these, in preference order:

1. **Ephemeral in-container option file**: send option-file content over stdin to a mode-600 random path in the already-running MySQL container, launch the interactive client referencing only that path, and remove it in `finally`.
2. **Inherited environment name only**: if Compose reliably supports `-e MYSQL_PWD` without a value, pass the secret through the host process environment while argv contains only the variable name. This is acceptable only if tests and a Docker smoke check prove the value never appears in argv/diagnostics; document that process environments remain sensitive.

Prefer option-file transport because it follows existing root-client conventions. Requirements for an in-container file:

- cryptographically random filename under a root-only directory such as `/run`;
- `umask 077`/mode 600;
- content sent via subprocess stdin, never a shell literal;
- MySQL option-file escaping for backslash and quote characters;
- username/password under `[client]`;
- cleanup on normal exit, client failure, and interrupt;
- no password in filename, argv, stdout, stderr, or exception text.

Do not use `docker compose cp` with a persistent host temporary credential unless cleanup and mode guarantees are stronger than stdin creation.

**Verify**: unit test uses sentinel `DO_NOT_LEAK_TEST_SECRET` and asserts it is absent from every captured argv and emitted message.

### Step 2: Preserve interactivity and exit codes

The shell must remain interactive after credential setup. A safe sequence may use separate Compose exec calls:

1. non-TTY `exec -T` receives option content on stdin;
2. normal interactive `exec` starts `mysql --defaults-extra-file=<random path>`;
3. non-TTY cleanup runs in `finally`.

Return/raise the interactive client's exit code as current behavior does. Cleanup failure should warn without masking a nonzero client exit, but a setup failure must prevent client launch.

Use Plan 006's Compose context for all three calls.

**Verify**: mocked tests cover setup failure, client success, client failure, KeyboardInterrupt/SystemExit path, and cleanup failure precedence.

### Step 3: Harden option-file generation

Factor the current MySQL option escaping (`vibeops/helpers.py:147-150`) into a reusable function that can generate root or app client content without logging it. Do not duplicate ad hoc quoting.

Ensure a username accepted by `APP_NAME_RE` cannot inject option-file lines. Passwords may contain arbitrary generated characters and quotes/backslashes; tests must cover them.

**Verify**: parse/structural tests assert one `[client]` section and no unescaped extra line from test credentials.

### Step 4: Add regression tests and docs

Create `tests/test_db_shell_security.py` with fake credential files in a temporary HOME_DIR. Cover missing credential behavior and all transport paths. Add a README note that app DB shell credentials are transferred through a protected ephemeral mechanism and are not put in host command arguments.

Do not state they are invisible to the Docker daemon or root.

**Verify**: focused tests and `make check` pass; source audit has no secret-valued argv construction.

## Test plan

Patch subprocess/Compose helper calls and all output functions. Recursively inspect lists, kwargs, exception messages, and captured output for the sentinel. Ensure cleanup is attempted exactly once after setup succeeds.

## Done criteria

- [ ] Password value never appears in host argv.
- [ ] Password value never appears in normal/error output.
- [ ] Temporary in-container credential is mode 600 and removed in `finally` if that design is used.
- [ ] Interactive behavior and exit code propagation remain intact.
- [ ] All calls honor local Compose overlays.
- [ ] Focused tests and `make check` pass.
- [ ] Plan 010 is marked DONE.

## STOP conditions

- The selected Compose version cannot preserve interactivity with the protected transport.
- Cleanup cannot be guaranteed after client interruption.
- Password escaping cannot be shared safely with existing option-file generation.
- A solution requires mounting all app home/credentials into the MySQL service.

## Maintenance notes

Any future command handling credentials must have a test sentinel proving absence from argv and logs. Option files and process environments are still secrets; keep scopes short and permissions restrictive.
