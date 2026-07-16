# Auto deploy from webhook (design)

Draft design for opt-in, per-app webhook deploys on bento. Core loop:

**webhook enqueues → app-user cron drains → one deploy at a time.**

Status: refine before implement. Edit freely.

---

## Verdict

**Keep**

- Opt-in per app
- HTTP endpoint on the app domain
- Durable queue under the app home
- Minute consumer as app user
- Single-flight deploys
- Exit code → status

**Change / add**

- HMAC auth
- Stack-owned webhook + drain scripts (not app-writable)
- File locking
- Queue policy
- Timeout
- Retention
- Stack-managed cron job (not hand-written)

**Note:** There is leftover evidence of an earlier deploy attempt (`deploy*.pyc`, compose mounts for missing `php-deploy-init` / `deploy-webhook.php`). Treat this as greenfield; that WIP can be ignored or scavenged later.

---

## Architecture

```text
GitHub/GitLab/generic CI
        │  POST https://app.example.com/_bento/deploy
        │  header: X-Bento-Signature: sha256=<hmac>
        ▼
Nginx (only if app.deploy.enabled)
  location = /_bento/deploy
        │  SCRIPT_FILENAME → stack-owned PHP (read-only mount)
        ▼
PHP-FPM (app pool, app UID)
  1. verify HMAC of raw body
  2. flock + append job to queue
  3. return 202 + job id
        │
        ▼
/home/<app>/.bento/
  secret          (0600, HMAC key)
  queue.json      (jobs + lock via flock)
  logs/<id>.log   (deploy stdout/stderr)
  deploy.sh       (app-owned hook; optional)
        │
        ▼
Supercronic (app user, * * * * *)
  bento-deploy-drain
  → one job: queued → running → success|failed
  → exec trusted command (default: sh deploy.sh)
```

### Ownership

| Piece | Who owns it | Writable by app? |
|---|---|---|
| Nginx location + render flag | bento CLI / state | no |
| Webhook PHP + drain binary | stack image/mounts | no |
| HMAC secret + queue + logs | runtime under `.bento/` | yes (app UID) |
| `deploy.sh` (or custom argv) | app / operator | yes |

Do **not** make the public webhook handler `/home/<app>/.bento/index.php`. Anything app-writable can be replaced after a code-level compromise and become a persistent RCE/deploy pivot. The app only supplies the deploy script.

---

## 1. Enablement (stack state)

In `stack.json` per app:

```json
"deploy": {
  "enabled": true,
  "timeout": 900,
  "queue_policy": "latest",
  "workdir": "/home/shop/www",
  "command": ["sh", "/home/shop/.bento/deploy.sh"]
}
```

>> It should include webhook secret in here , and DEPLOY_WEBHOOK_SECRET is set in fast_cgi pass param in nginx location.

### Suggested CLI

```bash
./manage.py deploy enable shop
./manage.py deploy enable shop --timeout 900 --queue-policy latest
./manage.py deploy enable shop -- sh /home/shop/.bento/deploy.sh
./manage.py deploy disable shop
./manage.py deploy webhook shop          # print URL + signature docs
./manage.py deploy rotate-secret shop
./manage.py deploy status shop
./manage.py deploy history shop
```

### On enable (render/apply)

1. Vhost gains the webhook location
2. System cron job `bento-deploy-drain` for that app (`* * * * *`, lock, timeout)
3. Init `.bento/` layout + secret if missing
4. Reload nginx + runner for that PHP version

This matches how access-log and cron are already opt-in via state + render.

---

## 2. Nginx location

Use an **exact** location so it works in both front-controller and legacy PHP modes:

```nginx
# only when deploy.enabled
location = /_bento/deploy {
    include /etc/nginx/snippets/php_fastcgi.conf;
    fastcgi_pass unix:/run/php-fpm/${PHP_SERVICE}/${APP_NAME}.sock;
    fastcgi_param SCRIPT_FILENAME /usr/local/lib/bento/deploy-webhook.php;
    fastcgi_param DOCUMENT_ROOT /home/${APP_NAME};
    # do not fall through to try_files / www
}
```

### Why this instead of app `index.php`

- Works with `php_entrypoint: front-controller` (which 404s other `.php`)
- `SCRIPT_FILENAME` is stack-owned, not under `www/`
- Path is short and stable; auth is HMAC, not obscurity

### open_basedir

Pool today is roughly:

```text
/home/<app>/:/tmp/:/usr/local/lib/php/:/var/log/php/
```

Either:

- allow `/usr/local/lib/bento/` in `open_basedir` (global or deploy-enabled pools), or
- place the webhook script under a path already allowed

Prefer extending open_basedir for the bento lib path.

>> It should be location /_bento and use frontcontroller /usr/local/lib/bento/index.php ( so later we can add more internal route into bento helper , eg : route for opcache clean, ...)

### Latency / FPM limits

Webhook must stay fast. FPM has `request_terminate_timeout = 60s`. **Enqueue only; never run deploy in the HTTP request.**

---

## 3. Auth (must-have)

Without auth, anyone who hits the domain can queue deploys.

### Recommended

- Secret: `/home/<app>/.bento/secret` (mode `0600`, app-owned)
- Header: `X-Bento-Signature: sha256=<hex>`
- Value: `HMAC-SHA256(secret, raw_request_body)`
- Constant-time compare
- Optional: reject if body > e.g. 256 KiB
- Optional: allow empty body (`{}`) for “just redeploy” pings

Do **not** put the secret in the URL. Opaque hook IDs are optional defense-in-depth; HMAC alone is enough for v1.

GitHub/GitLab can use a thin adapter later (`X-Hub-Signature-256`, etc.). Start generic; map CI later.

>> use X-Hub-Signature

---

## 4. Queue file design

Single file is fine if every reader/writer uses **`flock`**.

Suggested path: `/home/<app>/.bento/queue.json`

(One file can hold both active + recent terminal jobs.)

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "01JXYZ...",
      "status": "queued",
      "received_at": "2026-07-16T10:00:00+00:00",
      "started_at": null,
      "finished_at": null,
      "exit_code": null,
      "error": null,
      "log_file": "logs/01JXYZ.log",
      "request": {
        "method": "POST",
        "content_type": "application/json",
        "content_length": 1234,
        "delivery_id": "optional-header",
        "payload_sha256": "...",
        "payload": { "...": "truncated or full if small" }
      }
    }
  ]
}
```

### State machine

```text
queued → running → success
                 ↘ failed
```

>> has 1 more status is skipped (deploy script return code 999 or something defined)

Rules:

- Webhook only creates `queued`
- Drain is the only writer of `running` / terminal states
- Only one `running` at a time per app
- Crash recovery: if process dies while `running`, next drain can mark it `failed` with `error: "interrupted"` (or use a pid/lock file and reclaim after timeout)

### Queue policy

Important under rapid pushes.

| Policy | Behavior |
|---|---|
| `latest` (default) | New webhook marks older **queued** jobs as `failed`/`superseded`; keep only newest queued. Running job finishes first. |
| `fifo` | Append all; process in order; cap max queued depth (e.g. 20) |

Without `latest`, 30 pushes in 5 minutes becomes a long serial deploy backlog.

### Retention

- Keep last N terminal jobs (e.g. 20) in the JSON
- Keep logs for those jobs; prune older log files
- Do not unbounded-grow `queue.json`

>> Keep 30 jobs

### Payload storage

Prefer:

- always store hash + size + a few headers
- store full JSON body only if small
- never log Authorization headers

---

## 5. Drain consumer (Supercronic)

Managed cron (created with deploy enable), not something operators add by hand:

```text
* * * * *  bento-deploy-drain   # as app user via existing php-cron-job
```

Use existing `php-cron-job` features:

- **lock** (e.g. `deploy`) so overlapping minutes do not double-run
- **timeout** from `deploy.timeout`
- **workdir** from deploy config
- **output** to file under `/home/<app>/logs/` or `.bento/logs/`

>> **output** to file under `/home/<app>/logs/` , 

### Drain algorithm

1. `flock` queue
2. If any `running` past timeout → mark `failed`
3. If any `running` still valid → exit 0 (single-flight)
4. Pick oldest `queued`
5. Set `running`, open log file, release flock (or hold a separate deploy lock)
6. `exec` trusted command with env:
   - `BENTO_APP`
   - `BENTO_DEPLOY_ID`
   - `BENTO_DEPLOY_PAYLOAD_FILE` (optional path to payload snapshot)
   - `BENTO_DEPLOY_LOG`
7. On exit: flock, set `success`/`failed` + `exit_code` + timestamps
8. Apply retention

>> ok, always trigger a [app-host-whichtrigger-webhook]/_bento/clean-opcache request for clean opcache of app (possible ?? or have to clean opcache in app pool url ??)

**One deploy at a time** is enforced by lock + status check, not by “cron is every minute.”

---

## 6. What actually runs the deploy

### Preferred default

```bash
sh /home/<app>/.bento/deploy.sh
```

- Command comes from **stack state** (`deploy.command` argv), not from “whatever file appears”
- Default path is conventional; operator can override at enable time
- Exit code 0 → `success`, else `failed`

### Why not auto-discover `deploy.php` vs `deploy.sh`

- Discovery is ambiguous and surprising
- `php deploy.php` needs the right cwd/env and is easier to misuse
- Trusted argv in state is auditable via CLI

If both patterns matter, support only:

1. default `sh …/deploy.sh`
2. explicit `--command` at enable

Optional: if default script is missing, job fails with clear error (`deploy script missing`), do not hang.

>> OK, let it be deploy.sh, so if user can using 'php deploy.php' as he want (simple is best)

### Example app script

```bash
#!/bin/sh
set -eu
cd /home/shop/www
git fetch --all --prune
git reset --hard origin/main
composer install --no-dev --optimize-autoloader
php artisan migrate --force
php artisan config:cache
```

Deploy runs as the app user (same isolation as cron/workers).

---

## 7. Runtime layout under `/home/<app>/.bento/`

```text
.bento/
  secret                 # HMAC secret (0600)
  queue.json             # jobs (0640)
  queue.json.lock         # optional; or flock the json itself
  logs/
    <job-id>.log
  deploy.sh              # app-provided (optional until first real deploy)
```

>> we passed secret in nginx fastcgi param already, no need secret file

### Init on enable / FPM-runner start

(`php-deploy-init` style)

- mkdir `.bento` + `logs`
- create secret if missing
- touch empty queue if missing
- fix ownership to app:app

Do not put `.bento` under `www/`. Nginx already blocks `/\.` paths, but keep deploy state outside the document root entirely.

---

## 8. HTTP API contract

| Item | Value |
|---|---|
| Method | `POST` only |
| Path | `/_bento/deploy` |
| Auth | `X-Bento-Signature: sha256=…` |
| Success | `202 Accepted` + `{"id":"…","status":"queued"}` |
| Bad signature | `401` |
| Deploy disabled | location absent → `404` |
| Body too large | `413` |
| Queue full (fifo cap) | `429` or `503` |

GET can return a tiny status JSON later; not required for v1.

> X-Hub-Signature instead

---

## 9. What not to do in v1

| Skip | Why |
|---|---|
| Deploy inside the webhook request | FPM 60s limit; blocks workers; hard to recover |
| App-writable webhook PHP | RCE/deploy pivot |
| No auth / shared static token in query string | Trivial abuse |
| Unbounded multi-deploy parallel | Race on `git` / `composer` / caches |
| Redis/MySQL queue | Overkill; file+flock matches bento simplicity |
| Dedicated webhook FPM pool | Nice isolation, but not needed for v1 if handler is tiny |
| Parsing every CI vendor format | Generic HMAC + raw/json payload first |

---

## 10. Implementation map

Rough vertical slices:

1. **State + CLI** — `deploy enable/disable/webhook/rotate-secret/status/history`
2. **Runtime files** — `.bento` init, secret, queue schema helpers
3. **Webhook PHP** — HMAC verify + enqueue (mounted RO into PHP containers)
4. **Nginx template** — conditional `location = /_bento/deploy` + open_basedir allow
5. **Drain PHP/CLI** — consumer + state machine + retention
6. **Cron render** — auto job on enable via existing cron pipeline (`lock=deploy`)
7. **Docs + example `deploy.sh`**

Compose/renderer currently has some stale deploy mounts in generated `compose.d/bento-php-versions.yml` that are **not** produced by current `php_versions.py`. Clean that when implementing so render stays source of truth.

---

## 11. Open decisions (lock before coding)

| # | Topic | Options | Recommendation |
|---|---|---|---|
| 1 | Path | `/_bento/deploy` vs `/_bento/webhook_deploy` | `/_bento/deploy` |
| 2 | Queue policy default | `latest` vs `fifo` | `latest` |
| 3 | Command model | trusted argv in state vs discover `deploy.php\|sh` | trusted argv → `sh .bento/deploy.sh` |
| 4 | Latency | every minute only vs optional wake-from-webhook | minute is fine for v1 |
| 5 | CI compatibility | generic HMAC only vs GitHub/GitLab adapters | generic v1; adapters later |

---

## Summary

> **Opt-in app deploy webhook → stack-owned authenticated enqueue → per-app file queue with flock + state machine → minute Supercronic drain as app user → single-flight exec of a trusted deploy command → success/failed from exit code.**

Keeps bento’s isolation model (app UID, no host shell from the internet, generated nginx/cron from state) without building a mini CI platform.
