# Plan 006: First-class app FastCGI / WordPress cache opt-in

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 706f9ab..HEAD -- config/nginx/ bento/services/nginx.py bento/services/state.py bento/commands/parser.py bento/commands/access_log_commands.py bento/utils/env.py tests/test_access_log.py docs/ README.md`
> On mismatch, STOP and report.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (wrong cache rules can serve authenticated HTML to the wrong user)
- **Depends on**: none
- **Category**: perf / direction
- **Planned at**: commit `706f9ab`, 2026-07-11

## Why this matters

Global FastCGI and proxy cache zones are already declared in Nginx config, and a WordPress-oriented snippet exists, but generated app vhosts never opt in. Operators must hand-edit custom vhosts. Mirroring the `app access-log enable|disable|status` UX makes anonymous page caching a safe, reversible product feature and improves PHP capacity on multi-tenant hosts.

## Current state

- Zones in `config/nginx/global/00-nginx.conf`:

```nginx
proxy_cache_path /var/cache/nginx/proxy levels=1:2 keys_zone=proxy_cache:100m max_size=1g inactive=60m use_temp_path=off;
fastcgi_cache_path /var/cache/nginx/fastcgi levels=1:2 keys_zone=fastcgi_cache:100m max_size=1g inactive=60m use_temp_path=off;
```

- Snippet `config/nginx/snippets/wordpress_cache.conf` — cookie/admin bypass, uses `fastcgi_cache` zone
- App vhost template `config/nginx/templates/site.conf.template` — PHP locations include `php_fastcgi.conf` only; **no** cache include
- Access-log opt-in pattern (copy this product shape):
  - state: `app["access_log"] = bool`
  - CLI: `app access-log enable|disable|status`
  - render: `{% if ACCESS_LOG %}` in template
  - commands: `bento/commands/access_log_commands.py`
  - tests: `tests/test_access_log.py`

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Gate | `make check` | exit 0 |
| Focused | `python3 -B -m unittest tests.test_app_cache -v` | all pass |

## Scope

**In scope**:
- `config/nginx/templates/site.conf.template` — conditional include for cache snippet inside PHP locations (both HTTP and HTTPS server blocks; both front-controller and legacy PHP locations)
- `config/nginx/snippets/wordpress_cache.conf` — review; maybe add `generic_fastcgi_cache.conf` for non-WP apps
- `bento/services/nginx.py` — pass template vars from app state
- `bento/services/state.py` — normalize `fastcgi_cache` / `cache_mode` field
- `bento/commands/` — new `cache_commands.py` or extend a small module; wire in `parser.py`
- `tests/test_app_cache.py` — new
- `tests/test_reload_scope.py` — nginx-only reload for cache toggle
- `docs/architecture.md` + `README.md`

**Out of scope**:
- Proxy vhost caching (`proxy_cache`) — separate feature
- Microcaching for logged-in users
- Purging API (`fastcgi_cache_purge` needs nginx plus module — stock image may lack purge; do **not** require purge module)
- Brotli/zstd (see docs; separate)

## Git workflow

- Branch: `advisor/006-app-fastcgi-cache`
- Commit style: e.g. `app fastcgi cache optin`
- Do not push unless asked

## Product behavior

```text
./manage.py app cache enable <app> [--mode wordpress|generic] [--no-reload]
./manage.py app cache disable <app> [--no-reload]
./manage.py app cache status <app>
```

State fields (pick one consistent schema and document it):

```json
"fastcgi_cache": true,
"fastcgi_cache_mode": "wordpress"
```

or nested:

```json
"cache": {"fastcgi": "off|wordpress|generic"}
```

**Prefer flat fields** matching `access_log` simplicity:

- `fastcgi_cache`: bool
- `fastcgi_cache_mode`: `wordpress` | `generic` (default `wordpress` when enabling without flag)

### Modes

1. **wordpress** — include existing `wordpress_cache.conf` (admin/cookie/query bypass)
2. **generic** — new snippet that:
   - skips non-GET/HEAD
   - skips requests with `Authorization` header
   - skips if cookie is non-empty (conservative) **or** only known session cookie prefixes — be conservative for multi-tenant safety
   - `fastcgi_cache_valid 200 5m;` (shorter than WP snippet)
   - adds `X-FastCGI-Cache $upstream_cache_status`

### Security / correctness rules

- Default for new apps: **cache off**
- Enabling cache prints a warn: anonymous caching only; logged-in personalization requires correct bypass
- Front-controller and legacy modes both get the include **after** `include php_fastcgi.conf` inside the PHP location (same as wordpress_cache.conf header comment)
- Reload: nginx only (`SERVICE_TARGETS_NGINX`)

### Cache path writable by nginx

Ensure nginx container can write `/var/cache/nginx/fastcgi`. Stock image usually can; if path is missing, document `docker compose exec nginx mkdir ...` or add empty volume in compose **only if required**. Prefer verifying official nginx image default; if not writable, add:

```yaml
# only if needed
tmpfs or volume for /var/cache/nginx
```

Do not change host-network topology.

## Steps

### Step 1: Render tests first

Like `tests/test_access_log.py`:

- disabled → no `fastcgi_cache` directive in rendered vhost
- wordpress mode → includes bypass conditions / `X-WordPress-Cache` or status header
- generic mode → includes generic snippet markers

### Step 2: Snippets + template conditionals

Update `site.conf.template` with something equivalent to:

```nginx
include /etc/nginx/snippets/php_fastcgi.conf;
{% if FASTCGI_CACHE %}
    include /etc/nginx/snippets/${FASTCGI_CACHE_SNIPPET};
{% endif %}
```

Or hardcode snippet name from mode in the Python renderer (cleaner than dynamic include names if template engine is limited — check `bento/utils/template.py` capabilities).

### Step 3: State normalize + CLI

Normalize defaults in `normalize_db`. Implement enable/disable/status. Wire parser under `app cache`.

### Step 4: Reload scope + docs

Update architecture matrix and README performance section.

### Step 5: Gate

`make check`

## Test plan

| Case | Expect |
|------|--------|
| off | no cache directives |
| wordpress | WP cookie bypass present |
| generic | no WP-specific cookie names required |
| reload targets | nginx only |
| unknown mode | die |

## Done criteria

- [ ] `app cache enable|disable|status` works
- [ ] Default apps remain uncached
- [ ] Rendered vhosts match tests
- [ ] Docs warn about authenticated content
- [ ] `make check` passes
- [ ] `plans/README.md` → DONE

## STOP conditions

- Template engine cannot do the needed conditionals — use Python-side partial injection like TLS replacement (`apply_vhost_tls` pattern) instead of inventing a new engine
- Stock nginx cannot write cache path and fix requires large compose redesign — document manual volume and ship CLI/render still
- Request to cache POST or authenticated pages — refuse

## Maintenance notes

- Purge-on-deploy is a common follow-up (may need `nginx -s reload` or cache keys API)
- Reviewers: carefully read cookie bypass lists for WordPress/WooCommerce
