# Plan 012: App isolation model (primary unit = app slug)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 7ed5180..HEAD -- manage.py config/ README.md docs/ docker/php/bin/`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED–HIGH (CLI/schema/layout contract change; multi-tenant identity)
- **Depends on**: none strictly; if plan 011 (escaped grant patterns) is present, reuse its grant helper instead of inventing a second one
- **Category**: architecture / dx / security
- **Planned at**: commit `7ed5180`, 2026-07-09

## Why this matters

Today the product noun is **user**, with **site** nested under it:

```text
/home/<user>/<domain>
Linux user = PHP-FPM pool = MySQL user = <user>
optional DB = <user>_<suffix>
```

That is a shared-hosting tenant model. Isolation is between users, not between apps. Sites under one user share pool, `open_basedir`, and MySQL principal (`user_%` grants).

VibeOps is a vibe-coding ops stack. The unit people deploy is an **app** (one code tree, one PHP version, optional N DBs, one or more public hostnames). The plan makes **app** the primary isolation and CLI object, while keeping Linux/MySQL as generated machinery keyed by a stable slug.

## Product model (final)

### Identity

| Concept | Name | Rules |
|---------|------|--------|
| App slug | `app_name` | Unique stack-wide. Same regex as today’s username: `^[a-z_][a-z0-9_-]{0,31}$` (Linux-safe, ≤32 chars). |
| Linux user | `app_name` | UID allocated stably (reuse current 10000+ allocator, keyed by app). Home `/home/<app_name>`. |
| PHP-FPM pool | `app_name` | Socket `/run/php-fpm/<app_name>.sock` (versioned host path unchanged). `open_basedir=/home/<app_name>/:…` |
| MySQL user | `app_name` | `GRANT ALL ON \`<app_name>\_%\`.*` (prefix grant). |
| Databases | `<app_name>_<suffix>` | One app → N DBs. Suffix validates with existing `DB_NAME_RE`. |
| Main domain | required hostname | Primary public identity; used as default vhost / ACME focus. |
| Extra domains | 0..N hostnames | Same docroot and pool as main; all appear in `server_name`. |

**One slug, three OS roles.** Do not invent separate “php user” / “db user” product names. Docs may say “app identity” once.

### Multi-domain semantics

- An app always has exactly **one main domain**.
- Extra domains are **aliases of the same app** (same code, same PHP, same DBs).
- Changing main domain does **not** move the filesystem tree (docroot is app-stable).
- Domain uniqueness is stack-wide: a domain may belong to at most one app (or one proxy vhost). Reject collisions.

**Not multi-domain:** two separate codebases under one Linux account. That is **two apps**. Old multi-site-under-one-user is intentionally **not** preserved as one app.

### Filesystem layout

```text
runtime/home/<app_name>/
  www/                 # document root (stable; not renamed when domains change)
  logs/                # FPM slow/error logs (pool paths stay under home)
  .credentials/        # MySQL env files per mysql service
  .ssh/                # optional deploy keys
  .composer/           # Composer home (cron/cli already assume this pattern)
```

Container paths:

```text
/home/<app_name>
/home/<app_name>/www          # default workdir for shell/exec/cron
```

Nginx:

```text
root /home/<app_name>/www;
fastcgi_pass unix:/run/php-fpm/<php_service>/<app_name>.sock;
```

Vhost file naming (PHP apps):

```text
runtime/nginx/vhosts/app-<app_name>.conf
```

Why not `example.com.conf`: main domain can change; app slug is stable. Proxy vhosts remain domain-keyed:

```text
runtime/nginx/vhosts/<domain>.conf   # type=proxy only
```

### MySQL model (unchanged grant shape, renamed principal)

Keep prefix grants (supports 1 app → N DBs):

```sql
CREATE USER IF NOT EXISTS '<app_name>'@'%' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON `<app_name>\_%`.* TO '<app_name>'@'%';
CREATE DATABASE IF NOT EXISTS `<app_name>_<suffix>`;
```

Credentials file (same idea as today):

```text
runtime/home/<app_name>/.credentials/<mysql_service>.env
```

Suggested keys (align with plan 007 if present):

```text
MYSQL_HOST=<mysql_service>
MYSQL_PORT=3306
MYSQL_USER=<app_name>
MYSQL_PASSWORD=...
MYSQL_DATABASE_PREFIX=<app_name>_
# optional default DB when created with app:
MYSQL_DATABASE=<app_name>_<suffix>
DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_DATABASE  # if 007 dual keys exist
```

Default first DB suffix when requested at create: `app` → `<app_name>_app`.

### PHP / runtime machinery (keep)

- `php-user-sync` continues to materialize Linux users from `users.d/*.env` (files may keep names; content key stays `USERNAME=` = app_name). Optional later rename `users.d` → `apps.d` is **cosmetic** and out of this plan’s must-ship path unless trivial.
- Pool template `user = __USERNAME__` etc. stays; substitute app_name.
- Cron: `php-cron-as <app_name> <workdir> …`
- CLI/shell: run as Linux user `app_name`, workdir `/home/<app_name>/www` by default.

---

## CLI surface (final)

### Primary

```bash
# Create app: identity + pool + home + vhost + optional first DB
./manage.py app create <app_name> <main_domain> [db_suffix] \
  [--php 8.5] [--mysql-service mysql84] [--alias www.example.com] \
  [--no-mysql] [--no-index] [--no-reload] [--uid N]

# Domains
./manage.py app domain add <app_name> <domain>
./manage.py app domain remove <app_name> <domain>   # cannot remove main; use set-main first
./manage.py app domain set-main <app_name> <domain> # domain must already be on the app

# Inspect
./manage.py app list
./manage.py app show <app_name>

# Day-2 app ops (app_name only; no domain arg required)
./manage.py shell <app_name> [--php VERSION] [-w workdir]
./manage.py exec <app_name> [--php VERSION] [-w workdir] -- <cmd...>
./manage.py cron create <app_name> <job_name> '<schedule>' '<command>' [--php VERSION] [-w workdir]
```

### Databases (app-scoped)

If `db` group already exists (plans 008/009), rekey to app_name:

```bash
./manage.py db create <app_name> <suffix>          # → <app_name>_<suffix>
./manage.py db list [--app <app_name>]
./manage.py db user-reset <app_name> [--password ...]
./manage.py db backup --app <app_name>             # all <app_name>_* if backup exists
```

If `db` group does not exist yet, `app create … [db_suffix]` still creates the optional first DB; leave full `db *` to 008/009 but use **app_name** wording in any new code.

### Proxy / TLS (domain-keyed, unchanged ownership)

```bash
./manage.py proxy create <domain> <upstream> [--alias ...]
./manage.py tls acme <domain> ...
./manage.py tls cert <domain> ...
```

TLS operates on the **vhost that contains that server_name**. For PHP apps, editing TLS rewrites `app-<app_name>.conf` (find app by domain index).

### Deprecations

| Old | New | Behavior during transition |
|-----|-----|----------------------------|
| `user create <user>` | absorbed by `app create` | Keep as **hidden/compat alias** for one release: maps to ensuring app identity without domain, or print hard deprecation + exit 2. Prefer: alias that creates pool/home/mysql only and warns “use app create”. |
| `site create <user> <domain> [db]` | `app create` / `app domain add` | Compat: if `<user>` exists as app and domain free, treat as domain add **only when** docroot already exists and is the app www; **do not** create second code tree under app. Safer: hard deprecation message with equivalent `app` command. |
| `list users` / `list sites` | `list apps` (+ `list sites` as domain index) | Update wizard strings. |
| `shell/exec/cron` requiring user+domain | app_name only | Domain optional only if needed for disambiguation (should not be). |

**Recommendation for this plan:** implement new `app` commands fully; keep `user`/`site` as thin wrappers that print migration hints and call new paths only when unambiguous; document removal in a follow-up. Do not silently map old multi-site user trees into one multi-domain app.

### Wizard

Replace “Create user” / “Create PHP site” with:

1. Create app  
2. Add domain to app  
3. Open app shell  
4. Create cron  
5. Proxy / TLS / status (unchanged)

---

## `stack.json` schema (v2)

Bump `SCHEMA_VERSION` to **2**.

```json
{
  "schema": 2,
  "apps": {
    "shop": {
      "name": "shop",
      "uid": 10001,
      "php_version": "8.5",
      "php_service": "php85",
      "php_versions": ["8.5"],
      "mysql_service": "mysql84",
      "mysql_user": true,
      "mysql_credentials": "runtime/home/shop/.credentials/mysql84.env",
      "main_domain": "shop.example.com",
      "domains": ["shop.example.com", "www.shop.example.com"],
      "home": "runtime/home/shop",
      "root": "runtime/home/shop/www",
      "vhost": "runtime/nginx/vhosts/app-shop.conf",
      "databases": ["shop_app"],
      "tls": { "mode": "self-signed" },
      "created_at": "...",
      "updated_at": "..."
    }
  },
  "domains": {
    "shop.example.com": { "kind": "php", "app": "shop" },
    "www.shop.example.com": { "kind": "php", "app": "shop" },
    "api.internal": { "kind": "proxy", "domain": "api.internal" }
  },
  "sites": {},
  "users": {},
  "crons": {
    "shop/schedule": {
      "app": "shop",
      "job_name": "schedule",
      "php_version": "8.5",
      "schedule": "* * * * *",
      "command": "php artisan schedule:run",
      "workdir": "/home/shop/www",
      "file": "runtime/cron/php85/jobs/shop-schedule.cron"
    }
  },
  "updated_at": "..."
}
```

Notes:

- Keep empty `users`/`sites` keys temporarily if it reduces churn, or migrate-on-read and stop writing them.
- **Domain index** (`domains`) is required for O(1) collision checks and TLS lookup.
- Cron job files: rename pattern from `user-domain-job.cron` → `app-job.cron` (domain no longer in identity). Use `safe_app_part` + `safe_job_part`.
- Proxy metadata may live only under `domains` + generated conf; optional `sites` for proxy-only is fine if simpler.

### Load-time migration (schema 1 → 2)

On `load_db()`, if `schema < 2`:

1. For each `sites[domain]` with `type=php` and `user=U`:
   - If `apps[U]` does not exist: create app `U` with `main_domain=domain`, `domains=[domain]+aliases`, `root` **migrated path rules** below, uid from `users[U]`.
   - If `apps[U]` already exists (second site under same old user): **do not merge**. Create app name `U` only for the first site; for subsequent sites stop and instruct operator to split manually **or** create `U_<n>` apps. Prefer: migration creates separate apps only when old layout had separate dirs — use app_name = old username for first site; for additional sites use slug `U` + sanitized domain short form, e.g. `shop_blog` if free, else fail with clear message listing conflicts.
2. Copy mysql credential paths / php_versions from `users`.
3. Rebuild `domains` index.
4. Rewrite cron keys from `user/domain/job` → `app/job` when unambiguous.
5. Set `schema=2` on next `save_db()`.

**Filesystem migration (optional automatic, documented manual fallback):**

| Old | New |
|-----|-----|
| `runtime/home/<user>/<domain>/` | `runtime/home/<app>/www/` |
| `runtime/home/<user>/logs` | `runtime/home/<app>/logs` |
| `runtime/home/<user>/.credentials` | stay under home (same if app_name=user) |
| `runtime/nginx/vhosts/<domain>.conf` | regenerate as `app-<app>.conf` |

Automatic move only when:

- app_name equals old username, and  
- target `www` does not exist, and  
- exactly one PHP site under that user **or** this site is being split into its own app with a new home.

Otherwise print a checklist and leave files in place (operator moves + re-run `app create` / regenerate vhost).

---

## Templates / generators to update

| Path | Change |
|------|--------|
| `config/nginx/templates/site.conf.template` | `root /home/__APP_NAME__/www`; `fastcgi_pass …/__APP_NAME__.sock`; `set $site_user __APP_NAME__`; drop `__MAIN_DOMAIN__` from path (keep in comments/server_name via `__SERVER_NAMES__`) |
| `config/php/templates/pool.conf.template` | keep placeholders; optional rename USERNAME→APP_NAME in template text only if all writers updated |
| `config/php/templates/cron.cron.template` | comment “App: __APP_NAME__”; workdir default www |
| `config/php/templates/index.php.template` | write into `www/` |
| `config/mysql/templates/*` | principal remains username field = app_name; grant prefix unchanged |
| `docker/php/bin/php-user-sync` | no logic change if USERNAME=app_name |
| `docker/php/bin/php-cron-as` | no logic change |

---

## `manage.py` implementation map

### New / core helpers

- `APP_NAME_RE` — alias of current `USERNAME_RE` (or rename with same pattern).
- `DOCROOT_NAME = "www"`.
- `app_home(app) -> Path`, `app_www(app) -> Path`, `app_vhost_path(app) -> Path`.
- `allocate_uid(app_name, …)` — read/write `apps` instead of `users`.
- `ensure_app_identity(app_name, php_version, …)` — former `cmd_user_create` / `ensure_user` body (pool, users.d, home, mysql user).
- `assert_domain_free(domain, db, *, allow_app=None)`.
- `render_app_vhost(app_record)` — main + all domains → `server_name`; TLS block from app.tls.
- `migrate_stack_schema(db)` — 1→2 on load.

### Commands

- `cmd_app_create` — identity + www + index + vhost + domain index + optional db.
- `cmd_app_domain_add|remove|set_main` — rewrite vhost, update index, reload nginx.
- `cmd_app_list|show`
- Refactor `cmd_app_shell` / `cmd_app_exec` / `cmd_cron_create` to app-primary args.
- Update wizard + `list` + `status` dashboard counts (`apps` not `users`).

### Compatibility shims

- `user create` → warn + `ensure_app_identity` (no domain).
- `site create U D [db]` → if app U missing, `app create U D [db]`; if app U exists and D not on app, **only** `domain add` if operator also expected same docroot — **STOP**: print that multi-site is now multi-app and show `app create <new_slug> D`.

Safer shim rule (final):

```text
site create U D [db]:
  if U not in apps and no home/U:  app create U D [db]
  elif U in apps and D not in apps[U].domains:
       die("Use: ./manage.py app domain add U D   # same codebase
            or: ./manage.py app create <new_app> D [db]  # new isolation")
  else: idempotent regenerate vhost for app U
```

---

## Docs

Update in the same PR:

- `README.md` — architecture bullets, quick start create flow, layout tree (`/home/<app>/www`), shell/cron examples, multi-domain section.
- `docs/architecture.md` — apps, domain index, vhost naming, schema 2.
- Mention deprecation of user/site CLI.

---

## Out of scope

- Workspace/tenant grouping multiple apps under one human (shared SSH across apps).
- Per-domain docroots or multi-site WordPress network automation.
- Automatic merge of old multi-site users into multi-domain apps.
- Renaming PHP config dirs `users.d` → `apps.d` (optional follow-up).
- `app delete` / destructive teardown (follow-up with `--yes`).
- Changing MySQL grant model away from prefix (explicitly **kept**).
- Implementing plans 008–011 (only consume their helpers if already present).

---

## STOP conditions

Stop and report (do not improvise) if:

1. Existing live stack has multi-site users and automatic migration would merge different code trees into one `www`.
2. Domain collision with an existing proxy or app cannot be resolved without deleting data.
3. Linux username limits force silent truncation of app_name (must reject instead).
4. ACME / TLS rewrite assumes one conf per domain file name and multi-domain conf breaks current TLS helpers — fix TLS helpers to resolve via domain index, or stop if nginx ACME module cannot list multiple names (document limitation: all hostnames on one `server` block is the intended model).
5. Any step requires `rm -rf` of `runtime/home/*` without an explicit operator checklist.

---

## Git workflow

- Branch: `feat/012-app-isolation-model`
- Suggested commits (or one well-described commit if small enough):
  1. `feat: stack schema v2 apps + domain index`
  2. `feat: app create/domain CLI and www docroot`
  3. `feat: retarget shell/exec/cron to app slug`
  4. `docs: app isolation model and deprecations`
- Do NOT push unless asked.

---

## Steps

### Step 0: Drift check + inventory

```bash
git diff --stat 7ed5180..HEAD -- manage.py config/ README.md docs/ docker/php/bin/
./manage.py --help
python3 -m py_compile manage.py
```

Record whether plans 007/008/009/011 landed (affects credential keys and `db` group).

### Step 1: Schema + helpers (no behavior change yet)

1. Set `SCHEMA_VERSION = 2`.
2. Add `apps` / `domains` defaults in `load_db()`.
3. Implement `migrate_stack_schema()` for empty and simple single-site cases; unit-less manual check with a fixture `stack.json` if needed.
4. Add path helpers: `app_home`, `app_www`, `app_vhost_path`.

Verification:

```bash
python3 -m py_compile manage.py
./manage.py state init --force   # if safe in dev
./manage.py state show | head
```

### Step 2: Templates for www + app socket

1. Update `site.conf.template` root and fastcgi_pass to app/www layout.
2. Ensure pool `open_basedir` remains `/home/__USERNAME__/` (app home).
3. Index template writes to `www/index.php`.

Verification: render mentally / dry-run create in next step.

### Step 3: `app create` + identity

Implement `app create` using refactored `ensure_app_identity` (from `user create`):

- home, logs, www  
- users.d + pool.d  
- mysql user + optional first DB  
- vhost `app-<name>.conf` with main + aliases  
- stack `apps` + `domains`  
- php reload + nginx reload  

Verification (stack up preferred):

```bash
./manage.py app create demo demo.test app --php 8.4 --alias www.demo.test
test -d runtime/home/demo/www
test -f config/php/versions/8.4/users.d/demo.env
test -f config/php/versions/8.4/pool.d/demo.conf
test -f runtime/nginx/vhosts/app-demo.conf
grep -E 'server_name|root |fastcgi_pass' runtime/nginx/vhosts/app-demo.conf
# expect: demo.test www.demo.test; root /home/demo/www; socket .../demo.sock
```

### Step 4: Domain commands

Implement add / remove / set-main with collision checks and vhost regenerate.

Verification:

```bash
./manage.py app domain add demo alt.demo.test
./manage.py app domain set-main demo www.demo.test
./manage.py app domain remove demo alt.demo.test
./manage.py app show demo
```

### Step 5: Retarget shell / exec / cron / list / wizard / status

- Args: `app_name` only (default workdir `/home/<app>/www`).
- Cron file: `runtime/cron/phpXX/jobs/<app>-<job>.cron`.
- Wizard + README examples.

Verification:

```bash
./manage.py --help
./manage.py app --help
./manage.py shell --help
./manage.py list apps
# if stack running:
./manage.py exec demo -- php -v
```

### Step 6: Compatibility shims

Implement deprecation behavior for `user` / `site` as specified (no silent multi-site merge).

Verification:

```bash
./manage.py user create --help
./manage.py site create --help
# exercise shim messages on dummy names
```

### Step 7: Migration path for existing schema 1 data

1. Implement load-time migration for the common case: one user ↔ one PHP site.
2. Document multi-site split procedure in README.
3. Optional: one-shot note in `app list` if legacy paths `runtime/home/*/*` exist outside `www`.

Verification: craft a temporary schema-1 `stack.json` (backup real file first) and run `./manage.py list apps`.

### Step 8: Docs + plans status

1. Update `README.md`, `docs/architecture.md`.
2. Mark this plan DONE in `plans/README.md`.
3. `python3 -m py_compile manage.py` and `./manage.py --help` clean.

---

## Acceptance criteria

- [ ] Primary create path is `app create <app_name> <main_domain> [db_suffix]`.
- [ ] Linux user, FPM pool, MySQL user all equal `app_name`.
- [ ] Docroot is `/home/<app_name>/www` for all domains on that app.
- [ ] Extra domains share pool/docroot; main domain is metadata + first among equals in ops docs.
- [ ] MySQL prefix grant still allows N DBs: `<app_name>_<suffix>`.
- [ ] Domain uniqueness enforced via `domains` index.
- [ ] `shell` / `exec` / `cron` take `app_name` (not user+domain).
- [ ] Schema 2 written; simple schema 1 single-site stacks migrate or document clearly.
- [ ] Old multi-site-under-one-user is **not** auto-merged into one multi-domain app.
- [ ] README describes app model and multi-domain rules.
- [ ] `python3 -m py_compile manage.py` exits 0.

## Rollback

- Revert the feature branch / commit.
- Schema 2 `stack.json` is not fully compatible with old CLI; keep a backup of `stack.json` and `runtime/nginx/vhosts` before migrating a live host.
- Filesystem: if `www` move was applied, reverse move is manual (`www` → old domain dir) using the migration checklist printed by manage.py.

## Verification baseline

| Purpose | Command | Expected |
|---------|---------|----------|
| Syntax | `python3 -m py_compile manage.py` | exit 0 |
| Help | `./manage.py app --help` | lists create/domain/list/show |
| Compose | `docker compose config -q` | exit 0 (unchanged topology) |
| Create smoke | `app create` + path/vhost checks above | files exist; names match app slug |
