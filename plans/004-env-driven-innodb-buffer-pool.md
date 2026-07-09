# Plan 004: Env-driven InnoDB buffer pool sizing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- config/mysql/ compose.yml .env.example README.md`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (wrong pool size can OOM or under-perform; defaults must stay safe)
- **Depends on**: plans/001-tame-mysql-session-buffers.md (memory math)
- **Category**: perf
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

`innodb_buffer_pool_size = 512M` is hard-coded. Small VPS hosts sharing RAM with multi PHP-FPM can OOM; larger multi-site hosts leave performance on the table. Operators need a documented, env-tunable size that matches host class without editing committed cnf by hand every time.

## Current state

`config/mysql/conf.d/z-custom.cnf`:

```ini
innodb_buffer_pool_size = 512M
innodb_buffer_pool_chunk_size = 128M
```

`compose.yml` mysql service has no extra env for pool size. `.env.example` only has `MYSQL_ROOT_PASSWORD` and PHP/socket vars.

**Constraint**: Official MySQL image does **not** substitute env vars inside mounted `.cnf` files automatically. You need one of:
1. **Documented static profiles** (e.g. `z-custom.cnf` default 512M + optional `z-sizing-large.cnf.example` operators copy), or
2. **Entrypoint wrapper** that renders cnf from env (more invasive), or
3. **Command-line override** in compose: `command: ["mysqld", "--defaults-extra-file=...", "--innodb-buffer-pool-size=${MYSQL_INNODB_BUFFER_POOL_SIZE:-512M}"]` — Compose substitutes from host `.env`.

Prefer **option 3 + documentation** for minimal code: keep base cnf, allow compose command args to override. Chunk size must divide pool size.

MySQL rule: `innodb_buffer_pool_size` must be a multiple of `innodb_buffer_pool_chunk_size * innodb_buffer_pool_instances` (default instances often auto). With chunk 128M, valid sizes include 256M, 512M, 768M, 1024M, …

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compose | `docker compose config` | shows expanded command with pool size |
| Compile | n/a for conf | — |

## Scope

**In scope**:
- `compose.yml` (mysql `command` / environment documentation)
- `config/mysql/conf.d/z-custom.cnf` (default remains 512M or slightly safer; comments)
- `.env.example` (`MYSQL_INNODB_BUFFER_POOL_SIZE` with comment)
- `README.md` (sizing table: small/medium/large)
- Optional: `config/mysql/conf.d/README.md` or comment block in cnf only (prefer README section, avoid extra files unless useful)
- `plans/README.md` status

**Out of scope**:
- Session buffers (001)
- redo log / charset (005)
- Auto-detect host RAM in Python (too clever; do not implement)

## Git workflow

- Branch: `advisor/004-innodb-buffer-pool-env`
- Commit: `tune mysql buffer pool sizing`
- Do NOT push unless asked.

## Steps

### Step 1: Confirm 001 landed

```bash
grep -E '^read_buffer_size|^sort_buffer_size|^read_rnd_buffer_size' config/mysql/conf.d/z-custom.cnf || true
```

→ No multi-MB assignments. If still `2M`, **STOP** and implement/finish 001 first (or apply 001 in the same branch before this step, then continue).

### Step 2: Wire env override via compose command

Current:

```yaml
    command: ["--defaults-extra-file=/etc/mysql/conf.d/z-custom.cnf"]
```

Change to an explicit mysqld invocation that keeps the defaults-extra-file **and** allows override:

```yaml
    command:
      - --defaults-extra-file=/etc/mysql/conf.d/z-custom.cnf
      - --innodb-buffer-pool-size=${MYSQL_INNODB_BUFFER_POOL_SIZE:-512M}
```

Or if the image entrypoint requires `mysqld` as first arg, use the form that matches current working behavior. **Verify** with:

```bash
docker compose config
```

Inspect the rendered `command` for mysql. Ensure substitution works.

**Chunk size**: Keep `innodb_buffer_pool_chunk_size = 128M` in cnf. Document that `MYSQL_INNODB_BUFFER_POOL_SIZE` must be a multiple of 128M (or change chunk to 64M if you want finer steps — only if you update the README table).

If compose command-line override conflicts with cnf (both set), MySQL typically lets **command-line win** — confirm on first start or via docs; if not, remove the size from cnf and set only via command with default `512M`.

Preferred clean approach:
- Remove `innodb_buffer_pool_size` from `z-custom.cnf` (leave comment: set via compose/env)
- Set exclusively via compose command with default `512M`

### Step 3: `.env.example`

Add:

```env
# InnoDB buffer pool. Must be a multiple of 128M (chunk size). Examples:
# 256M small VPS, 512M default, 1G–2G multi-site hosts dedicated to this stack.
MYSQL_INNODB_BUFFER_POOL_SIZE=512M
```

Do not put real production values as secrets (this is not a secret).

### Step 4: README sizing guidance

Under Performance choices or a new short `### MySQL memory` subsection:

| Host RAM (approx) | Suggested `MYSQL_INNODB_BUFFER_POOL_SIZE` | Notes |
|-------------------|-------------------------------------------|--------|
| 1–2 GB | 256M | Shared with PHP/Nginx/Redis |
| 4 GB | 512M–1G | Default 512M |
| 8 GB+ | 1G–2G | Leave headroom for PHP-FPM |

State clearly: buffer pool is **not** “all free RAM”; leave room for OS page cache, PHP, Redis.

### Step 5: Validate

```bash
docker compose config -q
grep -n 'MYSQL_INNODB_BUFFER_POOL_SIZE' .env.example README.md compose.yml
```

Optional live:

```bash
docker compose up -d mysql
# then SHOW VARIABLES LIKE 'innodb_buffer_pool_size';
```

## Test plan

- Default with no env var → 512M (or documented default).
- Set `MYSQL_INNODB_BUFFER_POOL_SIZE=256M` in `.env` → `docker compose up -d mysql` reflects 256M.
- Invalid size (e.g. not multiple of chunk) — if mysqld refuses to start, document the multiple rule; do not write an auto-fixer.

## Done criteria

- [ ] Pool size tunable via `.env` / Compose without editing committed binary secrets
- [ ] Default remains safe (~512M or 256M if you deliberately lower — prefer keep 512M default)
- [ ] README has a sizing table
- [ ] `.env.example` documents the variable
- [ ] `docker compose config -q` exits 0
- [ ] `plans/README.md` 004 → DONE

## STOP conditions

- Command-line override ignored and cnf wins with no way to reconcile — pick one source of truth and document; if mysqld fails to boot after change, revert and report logs.
- Plan 001 not applied and 2M session buffers remain — fix 001 first.
- Temptation to auto-detect total host RAM in entrypoint — out of scope; STOP that approach.

## Maintenance notes

- When raising pool size, redo log capacity (plan 005) may need a proportional bump.
- Reviewer: ensure chunk/size multiple rule is documented; check no secret material in examples.
