# Plan 003: Harden Redis and write per-app Redis credentials

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- compose.yml docker/redis/ .env.example config/mysql/templates/user-credentials.env.template bento/services/mysql.py bento/services/php.py bento/utils/env.py README.md docs/`
> On mismatch with "Current state", STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (Redis config changes can break running apps if password is introduced without migration path)
- **Depends on**: none
- **Category**: perf / direction / security-hygiene
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

Redis is part of the default stack (`redis:6379` on the backend network) but has no healthcheck, no memory cap, and no per-app isolation in credentials files. Multi-tenant apps share one DB 0 with colliding key namespaces. Without `maxmemory`, Redis can OOM the host under cache abuse. Finishing Redis as a product surface matches MySQL’s credentials + healthcheck story.

## Current state

- `compose.yml` redis service (~245–254):

```yaml
  redis:
    build:
      context: ./docker/redis
    restart: unless-stopped
    logging: *default-logging
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis-data:/data
    networks:
      - backend
```

- `docker/redis/Dockerfile`: Debian redis-server, runs as `redis` user, default CMD
- App credentials template `config/mysql/templates/user-credentials.env.template` has MYSQL/DB only — README claims apps get:

```text
REDIS_HOST=redis
REDIS_PORT=6379
```

but the template currently **does not** include Redis keys (README aspirational / manual). Confirm and fix by extending the template.
- MySQL credentials written in `create_mysql_user` via `write_template(... user-credentials.env.template ...)`
- PHP services `depends_on` redis with `service_started` only (not healthy)
- Status lists redis as up/down but does not ping it (`cmd_status` in `runtime_commands.py`)

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Gate | `make check` | exit 0 |
| Compose config (if docker available) | `docker compose config` | valid YAML, redis has healthcheck |
| Unit tests | `python3 -B -m unittest discover -s tests -v` | pass |

## Scope

**In scope**:
- `compose.yml` — redis command/healthcheck/env
- `docker/redis/Dockerfile` — only if entrypoint needed (prefer pure compose `command:` overrides)
- `.env.example` — `REDIS_MAXMEMORY`, optional `REDIS_PASSWORD` documented
- `config/mysql/templates/user-credentials.env.template` — add REDIS_* keys (or rename path only if already planned; **do not** rename file in this plan)
- `bento/services/mysql.py` — when writing credentials, pass Redis template vars (or small helper)
- `bento/utils/env.py` — readers for redis maxmemory / password / defaults
- `bento/commands/runtime_commands.py` — optional redis ping line in `status`
- `tests/` — env/template unit tests (no live Redis required)
- `README.md` — document Redis knobs + per-app prefix/DB

**Out of scope**:
- Multiple Redis containers / Redis Cluster
- Full Redis ACL users per app (use DB index + key prefix instead)
- Migrating existing production Redis data layouts automatically beyond documenting the prefix convention
- Requiring password by default (must remain optional for backward compatibility)

## Git workflow

- Branch: `advisor/003-redis-hardening`
- Commit style: e.g. `redis health memory credentials`
- Do not push unless asked

## Product behavior

### A. Compose / runtime Redis

From `.env` (with safe defaults):

| Variable | Default | Meaning |
|----------|---------|---------|
| `REDIS_MAXMEMORY` | `256mb` | redis `maxmemory` |
| `REDIS_MAXMEMORY_POLICY` | `allkeys-lru` | eviction policy |
| `REDIS_PASSWORD` | empty | if set, require password; if empty, no auth (current behavior) |

`command` example shape (adjust quoting to compose interpolation):

```yaml
command:
  - redis-server
  - --appendonly
  - "yes"
  - --maxmemory
  - ${REDIS_MAXMEMORY:-256mb}
  - --maxmemory-policy
  - ${REDIS_MAXMEMORY_POLICY:-allkeys-lru}
```

If `REDIS_PASSWORD` is set, append `--requirepass` via a small entrypoint script **or** document that operators set it in `compose.override.yml` for password — **preferred approach for password**:

- Keep stock `compose.yml` without baking secrets into process list if avoidable
- Use env `REDIS_PASSWORD` and an entrypoint:

```sh
# docker/redis/docker-entrypoint.sh (if needed)
exec redis-server --appendonly yes --maxmemory "$REDIS_MAXMEMORY" ... \
  ${REDIS_PASSWORD:+--requirepass "$REDIS_PASSWORD"}
```

Healthcheck (always):

```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]
  interval: 5s
  timeout: 3s
  retries: 10
  start_period: 5s
```

If password is enabled, healthcheck must use `redis-cli -a` or `REDISCLI_AUTH` — implement correctly or STOP and use `redis-cli ping` only when no password.

Update PHP `depends_on.redis` to `condition: service_healthy` when healthcheck exists.

### B. Per-app credentials

When writing MySQL credentials env (and any path that regenerates that file), also set:

```text
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=<stable small int>
REDIS_PREFIX=<app_name>:
# if REDIS_PASSWORD set in stack env:
REDIS_PASSWORD=...
```

**DB allocation rule (keep simple)**:

- Derive from app UID: `REDIS_DB = uid % 16` (Redis default DBs 0–15) **or** store explicit `redis_db` on app state at create time
- Prefer **explicit field** `app["redis_db"]` allocated at first create (0–15 round-robin / free slot) and persisted in `stack.json` so it is stable
- `REDIS_PREFIX` always `${app_name}:` (validated app name is safe)

If 16 apps exceed DB indices, multiple apps may share a DB **but** prefixes still isolate keys — document this.

Do **not** print Redis password to stdout.

### C. Status

If redis running, try ping (compose exec redis redis-cli ping) and show ok/failed, similar to MySQL admin ping. Skip hard-fail if docker missing (tests/mac).

## Steps

### Step 1: Env helpers + tests

Add parsers in `bento/utils/env.py` for maxmemory string validation (simple non-empty token) and optional password presence. Unit test without docker.

### Step 2: Credentials template + write path

Extend `user-credentials.env.template` and the `write_template` call sites so new apps get Redis keys. Add unit test that rendered credentials contain `REDIS_HOST=redis` and a prefix.

### Step 3: App state field

On `ensure_app_identity` / `cmd_app_create` path, set `redis_db` once if missing. Document in architecture app model.

### Step 4: Compose + redis image entrypoint

Implement maxmemory + healthcheck; password optional. Update `.env.example`.

### Step 5: Status ping

Lightweight redis ping in `cmd_status`.

### Step 6: Docs + gate

README Performance / Redis section. `make check`.

## Test plan

- Template rendering includes REDIS_* 
- `redis_db` stable on re-create (not reallocated)
- Env defaults documented; no secret values in tests (use fake password strings only in temp dirs)

## Done criteria

- [ ] Redis service has healthcheck in `compose.yml`
- [ ] maxmemory + policy configurable via `.env.example`
- [ ] New/updated credential files include REDIS_HOST/PORT/DB/PREFIX
- [ ] Password remains optional; enabling it is documented
- [ ] `make check` passes
- [ ] `plans/README.md` → DONE

## STOP conditions

- Changing Redis image base breaks build on arch — report
- Password healthcheck cannot be made correct without leaking secrets into compose process list in a worse way than today — implement maxmemory+healthcheck without password and document password as override-only
- More than cosmetic changes needed to MySQL credential path that break mode 600 guarantees — stop and re-read `create_mysql_user`

## Maintenance notes

- Reviewers: check multi-tenant prefix docs; warn that apps must use the prefix in code (Laravel `REDIS_PREFIX` / cache prefix)
- Future: Redis ACL users per app; second Redis for sessions vs cache
