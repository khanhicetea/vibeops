# Plan 001: Tame MySQL per-session buffer memory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- config/mysql/conf.d/z-custom.cnf README.md docs/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (session-buffer changes can affect sort-heavy queries; defaults are usually better)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

`read_buffer_size`, `read_rnd_buffer_size`, and `sort_buffer_size` are allocated **per connection**, not globally. With `max_connections = 150` and each of those set to `2M`, theoretical session RAM is hundreds of MB **on top of** the 512M InnoDB buffer pool. On a small VPS that also runs Nginx + multi PHP-FPM, MySQL is an OOM candidate under concurrent load. Restoring conservative defaults (or removing the overrides) stabilizes multi-tenant hosts without sacrificing typical PHP app performance.

## Current state

- `config/mysql/conf.d/z-custom.cnf` — sole mysqld tuning file, mounted read-only into the MySQL container.
- `compose.yml` mounts it at `/etc/mysql/conf.d/z-custom.cnf` and starts with `--defaults-extra-file=...`.
- PHP-FPM pools use `pm.max_children = 6` (`config/php/templates/pool.conf.template`) — many users can still open many connections, so per-session waste multiplies.

Excerpt (`config/mysql/conf.d/z-custom.cnf`):

```ini
max_connections = 150
...
read_rnd_buffer_size = 2M
read_buffer_size = 2M
sort_buffer_size = 2M
```

**Repo conventions**: short imperative commit messages (`enhance nginx`, `fix cron`). No unit tests. Pure Python + Compose. Prefer small, documented config changes with a README note when behavior is operator-facing.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Drift | `git diff --stat 7ed5180..HEAD -- config/mysql/conf.d/z-custom.cnf README.md` | empty or reviewed |
| Syntax conf | visual/grep after edit | no `2M` on those three keys |
| Python (no-op) | `python3 -m py_compile manage.py` | exit 0 |
| Compose | `docker compose config -q` | exit 0 if `.env` present |
| Live apply (optional) | `docker compose up -d mysql` then check vars | new defaults active |

## Scope

**In scope**:
- `config/mysql/conf.d/z-custom.cnf`
- `README.md` (brief note under Performance choices about session buffers / connection budget)
- `plans/README.md` (status row only)

**Out of scope**:
- `innodb_buffer_pool_size` changes → plan 004
- charset / redo / io capacity → plan 005
- healthcheck → plan 002
- `max_connections` drastic redesign (you may add a short comment; do not invent complex formulas)
- PHP pool `pm.max_children`

## Git workflow

- Branch: `advisor/001-tame-mysql-session-buffers`
- Commit style: short, e.g. `tune mysql session buffers`
- Do NOT push or open a PR unless asked.

## Steps

### Step 1: Remove oversized per-session buffer overrides

Edit `config/mysql/conf.d/z-custom.cnf`.

**Remove these three lines entirely** (prefer MySQL defaults over inventing new large values):

```ini
read_rnd_buffer_size = 2M
read_buffer_size = 2M
sort_buffer_size = 2M
```

Optionally add a short comment block (comments use `#` in MySQL cnf) explaining why they are unset:

```ini
# Per-session buffers intentionally left at server defaults.
# Large global overrides (e.g. 2M × max_connections) risk OOM on multi-tenant hosts.
```

Leave `max_connections = 150` unless you have evidence to change it; if you change it, only to a still-documented integer (e.g. 100) with a comment referencing PHP pool children — do not invent env wiring here.

**Verify**:

```bash
grep -E 'read_buffer_size|read_rnd_buffer_size|sort_buffer_size' config/mysql/conf.d/z-custom.cnf || true
```

→ No active assignment lines (comment-only mentions of the names are OK). Must not match `= 2M` for those three.

```bash
grep -n 'max_connections\|innodb_buffer_pool' config/mysql/conf.d/z-custom.cnf
```

→ Those unrelated settings still present.

### Step 2: Document the rationale in README

In `README.md`, under `## Performance choices` (near the MySQL bullet about backend network isolation), add one bullet:

- MySQL keeps per-session sort/read buffers at server defaults so concurrent PHP connections do not multiply multi-megabyte allocations; size `innodb_buffer_pool_size` for the host instead.

Do not invent new sections beyond that bullet.

**Verify**:

```bash
grep -n 'per-session\|session buffer\|sort/read' README.md
```

→ At least one hit in the Performance choices area.

### Step 3: Compose still parses

If `.env` exists with `MYSQL_ROOT_PASSWORD`:

```bash
docker compose config -q
```

→ exit 0

If no `.env`, skip compose and note it in the completion report.

**Optional live check** (only if MySQL is running and operator-safe to recreate):

```bash
docker compose up -d mysql
docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SHOW VARIABLES WHERE Variable_name IN ('read_buffer_size','read_rnd_buffer_size','sort_buffer_size');"
```

→ Values should be **well below** 2M (MySQL 8.4 defaults are typically 128KiB / 256KiB class — exact numbers may vary; assert each is `< 2097152`).

Prefer using the safe exec pattern from plan 003 if already applied; otherwise temporary use of container env is fine for verification only — never commit passwords.

## Test plan

- No automated tests exist. Manual: conf grep gates above + optional live `SHOW VARIABLES`.
- Regression: a site that previously relied on huge global `sort_buffer_size` for a one-off huge `ORDER BY` may need a session-level `SET SESSION sort_buffer_size=...` — document in Maintenance notes only, do not re-raise global defaults.

## Done criteria

- [ ] `read_buffer_size`, `read_rnd_buffer_size`, `sort_buffer_size` are not set to `2M` (or any multi-megabyte override) in `z-custom.cnf`
- [ ] `innodb_*` and other unrelated settings unchanged except optional comment additions
- [ ] README Performance choices mentions session-buffer rationale
- [ ] `python3 -m py_compile manage.py` still exits 0 (untouched)
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row for 001 → DONE

## STOP conditions

- `z-custom.cnf` no longer matches the excerpt structure (large rewrite already landed).
- Operator requires keeping 2M buffers for a measured workload — stop and report; do not half-apply.
- MySQL fails to start after conf change — revert conf change and report the error log.

## Maintenance notes

- Future heavy analytical queries should use **session** `SET`, not global multi-MB session buffers.
- Plan 004 sizes the buffer pool; keep session buffers default when reviewing 004 memory budgets.
- Reviewer should confirm no other per-connection knobs (`join_buffer_size`, etc.) were reintroduced at multi-MB scale.
