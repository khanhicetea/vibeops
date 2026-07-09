# Plan 002: Add MySQL healthcheck and healthy depends_on for PHP

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7ed5180..HEAD -- compose.yml manage.py README.md`
> If in-scope files drifted, re-read live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (parallel-safe with 001)
- **Category**: stability
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

PHP services list `depends_on: [mysql, redis]` without a readiness condition. Compose only waits for the **container process to start**, not for mysqld to accept connections. On cold boot or after a crash loop, PHP-FPM, cron, and CLI can hit "connection refused" until MySQL finishes recovery. A `healthcheck` plus `condition: service_healthy` removes that race for all PHP services that share `x-php-common`.

## Current state

`compose.yml` — PHP anchor and mysql service:

```yaml
x-php-common: &php-common
  ...
  depends_on:
    - mysql
    - redis
  networks:
    - backend
...
  mysql:
    image: mysql:8.4
    restart: unless-stopped
    command: ["--defaults-extra-file=/etc/mysql/conf.d/z-custom.cnf"]
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?set MYSQL_ROOT_PASSWORD in .env}
      TZ: ${TZ:-Asia/Ho_Chi_Minh}
    volumes:
      - mysql-data:/var/lib/mysql
      - ./config/mysql/conf.d/z-custom.cnf:/etc/mysql/conf.d/z-custom.cnf:ro
      - ./runtime/backups/mysql:/backups
    networks:
      - backend
```

`manage.py` `cmd_status` only prints whether the service name appears in `docker compose ps --services --filter status=running` — not whether MySQL accepts queries.

**Conventions**: YAML anchors already used (`x-php-common`). Keep healthcheck simple (official image has `mysqladmin`). No third-party deps in `manage.py`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compose validate | `docker compose config -q` | exit 0 |
| Health after up | `docker compose ps mysql` | healthy (when stack running) |
| Status CLI | `./manage.py status` | shows mysql + optional ping line |

## Scope

**In scope**:
- `compose.yml` (mysql healthcheck; php `depends_on` shape)
- `manage.py` (`cmd_status` only — optional MySQL ping line)
- `README.md` (one short note if boot order is documented; optional)
- `plans/README.md` status

**Out of scope**:
- Redis healthcheck (nice-to-have; do not expand unless trivial and same PR already touches depends_on — preferred: MySQL only for this plan)
- Changing `network_mode` / exposing MySQL ports
- Backup tooling

## Git workflow

- Branch: `advisor/002-mysql-healthcheck`
- Commit message style: `mysql healthcheck` or `enhance mysql readiness`
- Do NOT push unless asked.

## Steps

### Step 1: Healthcheck on mysql service

In `compose.yml`, under `services.mysql`, add:

```yaml
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p$$MYSQL_ROOT_PASSWORD"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 30s
```

**Critical Compose escaping**: use `$$MYSQL_ROOT_PASSWORD` so Compose passes a literal `$MYSQL_ROOT_PASSWORD` into the container (the official image already has this env). Do **not** interpolate the host password into `compose.yml`.

Alternative if `mysqladmin -p$$...` is awkward on your Compose version (STOP if health never becomes healthy after trying both):

```yaml
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1"]
```

Some MySQL image versions allow ping without auth for local admin; prefer root+env form first.

**Verify**:

```bash
docker compose config -q
```

→ exit 0

```bash
docker compose config | grep -A20 'mysql:' | head -40
```

→ shows `healthcheck` under mysql; password value from `.env` must **not** appear in plaintext as a substituted healthcheck arg if you used `$$`.

### Step 2: Healthy depends_on for PHP services

Replace the list form under `x-php-common`:

```yaml
  depends_on:
    - mysql
    - redis
```

with:

```yaml
  depends_on:
    mysql:
      condition: service_healthy
    redis:
      condition: service_started
```

Keep Redis as `service_started` only (no Redis healthcheck in this plan). All services using `<<: *php-common` inherit this.

**Verify**:

```bash
docker compose config -q
docker compose config | grep -A15 'depends_on' | head -40
```

→ php services show mysql `service_healthy`.

### Step 3: Optional status ping in manage.py

In `cmd_status` (`manage.py`), after the Docker services loop, if `"mysql" in running`, try a non-fatal readiness check:

```python
    if "mysql" in running:
        cp = run(
            [
                "docker", "compose", "exec", "-T", "mysql",
                "sh", "-lc",
                'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
            ],
            check=False,
            capture=True,
        )
        info(f"  mysql ping: {'ok' if cp.returncode == 0 else 'failed'}")
```

Place under "Quick checks" section. Do not print passwords. Do not fail `status` if ping fails — only report.

If plan 003 already introduced a helper like `mysql_root_exec` / `mysql_admin_ping`, reuse it instead of duplicating.

**Verify**:

```bash
python3 -m py_compile manage.py
./manage.py status
```

→ exit 0; when mysql is up and healthy, shows `mysql ping: ok` (or equivalent).

### Step 4: Live boot order (when Docker available)

```bash
docker compose up -d mysql
docker compose ps mysql
```

→ `healthy` within ~start_period+retries.

```bash
docker compose up -d php84
```

→ php84 starts only after mysql is healthy (Compose v2).

## Test plan

- Cold start: `docker compose down` (careful: do **not** remove volumes unless operator allows) then `up -d` — PHP should not stay permanently starting while mysql is unhealthy.
- Break mysql password in a **throwaway** clone only — do not corrupt operator `.env` in production; if testing failure path, use a disposable project copy.

## Done criteria

- [ ] `services.mysql.healthcheck` present in `compose.yml`
- [ ] PHP common `depends_on.mysql.condition` is `service_healthy`
- [ ] Redis still starts without requiring a redis healthcheck
- [ ] `docker compose config -q` exits 0
- [ ] `python3 -m py_compile manage.py` exits 0
- [ ] No secrets committed; healthcheck uses container env via `$$` or no password
- [ ] `plans/README.md` 002 → DONE

## STOP conditions

- Compose version cannot parse long `depends_on` syntax (very old Compose) — report and keep healthcheck-only if forced.
- Healthcheck stays unhealthy for >3 minutes with correct root password — inspect `docker compose logs mysql` and stop.
- Changing depends_on breaks nginx-only workflows unexpectedly — nginx does not depend on mysql today; do not add that dependency.

## Maintenance notes

- InnoDB crash recovery may exceed `start_period: 30s` on large datasets — raise `start_period` / `retries` rather than removing the healthcheck.
- Plan 008 backups should not disable healthchecks.
- Reviewer: confirm `$$` escaping so host secrets never land in the rendered config as literals from the healthcheck line.
