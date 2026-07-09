# Plan 005: MySQL 8.4 defaults polish (charset, redo, I/O, packet)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- config/mysql/conf.d/z-custom.cnf compose.yml README.md`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED (redo log resize can delay first restart; charset change affects new objects)
- **Depends on**: plans/001-tame-mysql-session-buffers.md
- **Category**: tech-debt
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

The stock cnf mixes good settings with dated ones: `innodb_log_file_size` is legacy vs `innodb_redo_log_capacity` on MySQL 8.0.30+; `innodb_io_capacity = 400` under-uses modern cloud SSD/NVMe; `max_allowed_packet = 16M` frustrates large dumps/migrations; server-level charset is unset while CREATE DATABASE templates use utf8mb4. Aligning these improves import DX, I/O throughput, and consistency with PHP apps.

## Current state

`config/mysql/conf.d/z-custom.cnf` (full file at plan time):

```ini
[mysqld]
bind-address = 0.0.0.0
skip_name_resolve

disable_log_bin
connect_timeout = 10
max_allowed_packet = 16M
max_connections = 150
max_heap_table_size = 64M
open_files_limit = 65535
read_rnd_buffer_size = 2M   # may already be removed by plan 001
read_buffer_size = 2M
sort_buffer_size = 2M
table_open_cache = 2000
tmp_table_size = 64M
wait_timeout = 300

innodb_buffer_pool_size = 512M
innodb_buffer_pool_chunk_size = 128M
innodb_log_file_size = 256M
innodb_file_per_table = 1
innodb_flush_method = O_DIRECT
innodb_io_capacity = 400
innodb_log_buffer_size = 8M
innodb_strict_mode = 1
```

CREATE DATABASE template already uses `utf8mb4` / `utf8mb4_unicode_ci`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compose | `docker compose config -q` | exit 0 |
| Live vars (optional) | `SHOW VARIABLES` for packet/charset/redo | new values |

## Scope

**In scope**:
- `config/mysql/conf.d/z-custom.cnf`
- Optional env knobs in `compose.yml` / `.env.example` for `innodb_io_capacity` only if simple (not required)
- Brief README note if packet size / charset affects operators
- `plans/README.md` status

**Out of scope**:
- Enabling binlog (plan 010)
- Buffer pool sizing mechanism (plan 004) — do not fight 004; if 004 removed pool from cnf, leave it removed
- Session buffers (001)

## Git workflow

- Branch: `advisor/005-mysql-84-polish`
- Commit: `polish mysql 8.4 defaults`
- Do NOT push unless asked.

## Steps

### Step 1: Apply 001-compatible baseline

Ensure multi-MB `read_*` / `sort_buffer_size` are not reintroduced.

### Step 2: Update z-custom.cnf settings

Apply these changes (keep unrelated good settings):

| Setting | Action |
|---------|--------|
| `max_allowed_packet` | `64M` (import/migration DX) |
| `character-set-server` | `utf8mb4` **add** |
| `collation-server` | `utf8mb4_unicode_ci` **add** |
| `innodb_log_file_size` | **remove** |
| `innodb_redo_log_capacity` | **add** e.g. `512M` (or `536870912`) |
| `innodb_io_capacity` | raise to `1000` (cloud SSD baseline) |
| `innodb_io_capacity_max` | **add** `2000` |
| `innodb_log_buffer_size` | keep `8M` or raise to `16M` if you touch redo — either OK |
| `skip_name_resolve`, `disable_log_bin`, `innodb_flush_method`, `innodb_strict_mode`, `innodb_file_per_table` | **keep** |

Example target fragment:

```ini
max_allowed_packet = 64M
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci

innodb_file_per_table = 1
innodb_flush_method = O_DIRECT
innodb_io_capacity = 1000
innodb_io_capacity_max = 2000
innodb_log_buffer_size = 16M
innodb_redo_log_capacity = 512M
innodb_strict_mode = 1
```

Do **not** enable slow query log here (plan 006).

### Step 3: README one-liner (optional but preferred)

Under Performance choices: note utf8mb4 server defaults and 64M `max_allowed_packet` for dumps/migrations.

### Step 4: Restart awareness

Document in commit body / README: first restart after redo capacity change may resize redo files and take longer than usual — normal.

**Verify**:

```bash
grep -nE 'innodb_log_file_size|innodb_redo_log_capacity|max_allowed_packet|character-set-server|innodb_io_capacity' config/mysql/conf.d/z-custom.cnf
```

→ No `innodb_log_file_size`; redo capacity present; packet 64M; charset set; io_capacity ≥ 1000.

```bash
docker compose config -q
```

→ exit 0

Optional live after `docker compose up -d mysql`:

```sql
SHOW VARIABLES WHERE Variable_name IN (
  'max_allowed_packet','character_set_server','collation_server',
  'innodb_redo_log_capacity','innodb_io_capacity','innodb_io_capacity_max'
);
```

## Test plan

- MySQL container becomes healthy after recreate.
- Create a database via existing manage path still utf8mb4.
- Large packet: not fully testable without a 20MB+ import; static conf check is enough.

## Done criteria

- [ ] `innodb_log_file_size` removed; `innodb_redo_log_capacity` set
- [ ] Server charset/collation utf8mb4 / utf8mb4_unicode_ci
- [ ] `max_allowed_packet` ≥ 64M
- [ ] `innodb_io_capacity` raised for SSD-class defaults
- [ ] Plan 001 session-buffer wins preserved
- [ ] `plans/README.md` 005 → DONE

## STOP conditions

- MySQL 8.4 rejects a variable name — check version (`SELECT VERSION();`) and use the supported equivalent; do not force deprecated names.
- Data directory corruption after redo change (extremely rare) — restore from backup / volume; stop further conf experiments.
- Conflict with plan 004 mid-flight — coordinate so both end with one clear buffer pool source of truth.

## Maintenance notes

- If buffer pool grows to 2G+ (plan 004), consider raising `innodb_redo_log_capacity` toward 1G.
- Reviewer: confirm `disable_log_bin` still present (PITR is plan 010, not this plan).
