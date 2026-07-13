---
name: bento
description: Operate this repository's bento stack: host-network Nginx, managed PHP-FPM and MySQL versions, Redis, app isolation, Unix sockets, ACME TLS, cron, workers, backups, generated state, customization, deployment, and troubleshooting. Use for app deployment, domains, proxies, runtime versions, databases, Compose/Nginx/PHP changes, or production incidents in this stack.
---

# bento

Use this skill for work in the bento repository or for deploying applications onto a bento host.

## Start here

1. Confirm the stack root contains `config/compose.yml`, `manage.py`, `dc`, `bento/`, `config/`, and `runtime/`.
2. Read `README.md` for operator workflows and `docs/architecture.md` before changing state/render/service behavior.
3. Read `docs/customization.md` before changing Compose mounts, Nginx vhosts, or PHP pools.
4. Inspect the implementation related to the change; `manage.py` is only a thin entrypoint and command parsing is in `bento/commands/parser.py`.
5. Use `references/deploy-runbook.md` for production checks and incident commands.

The interactive wizard is available as `./manage.py` or `./manage.py wizard`; it is self-guided and prints equivalent CLI commands. Prefer the documented CLI for automation and agent work.

## Mental model

- `runtime/state/stack.json` is desired state. `runtime/generated/` is disposable output; never edit it directly.
- Core topology is `config/compose.yml`. Managed PHP and MySQL services are generated in `compose.d/bento-php-versions.yml` and `compose.d/bento-mysql-versions.yml`.
- Always use `./dc` or `./manage.py compose`, not bare Compose, so generated and local fragments load.
- Nginx uses `network_mode: host`, directly binding `80/tcp`, `443/tcp`, and `443/udp`. Do not add `ports:` without redesigning ingress.
- A fresh state manages PHP 8.5 and MySQL 8.4. `php add` generates FPM, runner, and CLI roles; `mysql add` generates a durable service and named volume.
- PHP-FPM communicates with Nginx through per-app Unix sockets:
  - host: `runtime/run/php-fpm/php85/<app>.sock`
  - Nginx: `/run/php-fpm/php85/<app>.sock`
  - PHP container: `/run/php-fpm/<app>.sock`
- An app slug is its Linux user/group, FPM pool, MySQL user, and `runtime/home/<app>/` directory. Code lives at `www/`.
- Every app is assigned to exactly one MySQL service. Redis and MySQL are private on the Compose `backend` network.
- `phpXX-runner` uses Supervisord for app-owned Supercronic schedulers and long-running workers. Never scale a runner above one replica.
- Generated vhosts boot with a self-signed cert, then state may select NGINX ACME or external cert files.

## Bootstrap

```bash
cp .env.example .env
${EDITOR:-vi} .env
./manage.py render
./dc up -d --build
./manage.py status --check-nginx
```

On production Linux, first confirm no host web server owns ports 80/443. Require long MySQL/Redis passwords in `.env`.

## Common operations

### Create and deploy an app

```bash
./manage.py app create shop shop.example.com app --php 8.5 --alias www.shop.example.com
# Laravel/Symfony:
./manage.py app create shop shop.example.com app --public-dir public

./manage.py exec shop -- composer install --no-dev --optimize-autoloader
./manage.py exec shop -- php artisan migrate --force
./manage.py shell shop
./manage.py tls acme shop.example.com
```

The database suffix `app` creates `shop_app`. Credentials are mode-600 files under `runtime/home/shop/.credentials/`. Use `mysql84:3306` and `redis:6379`, never localhost, from PHP.

### Domains and proxies

```bash
./manage.py app domain add shop alt.shop.example.com
./manage.py app domain set-main shop alt.shop.example.com
./manage.py app domain remove shop www.shop.example.com
./manage.py proxy create api.example.com http://127.0.0.1:3000
./manage.py tls acme api.example.com
```

For host-network Nginx, proxy upstream `127.0.0.1` is the host namespace, not a Compose bridge container.

### Runtime versions

```bash
./manage.py php versions
./manage.py php add 8.4
./dc up -d --build php84 php84-runner
./manage.py app create shop shop.example.com --php 8.4
./manage.py php remove 8.5   # rejected while in use

./manage.py mysql versions
./manage.py mysql add 5.7
./dc up -d mysql57
```

MySQL removal is intentionally unsupported. Back up and migrate before deliberate manual retirement.

### Database operations

```bash
./manage.py db list --mysql-service mysql84
./manage.py db shell --mysql-service mysql84
./manage.py db stats --mysql-service mysql84
./manage.py db process-list --mysql-service mysql84
./manage.py db backup --app shop --gzip --keep 14
./manage.py db list-backups --mysql-service mysql84
./manage.py db restore <dump.sql.gz> --database shop_app --new-suffix restored
```

Original replacement requires `--confirm-database shop_app`. Dumps are atomically finalized, but restore is not object-level atomic. Keep off-host copies. Never use `down -v`; it destroys database volumes.

### Cron and workers

```bash
./manage.py cron create shop scheduler '* * * * *' 'php artisan schedule:run'
./manage.py cron list --app shop
./manage.py cron remove shop scheduler

./manage.py worker create shop queue --stop-timeout 120 -- php artisan queue:work
./manage.py worker status shop
./manage.py worker restart shop queue
./manage.py worker remove shop queue
```

Worker commands are argv. Use `-- sh -lc '...'` only when shell syntax is needed.

### Render and validate

```bash
./manage.py render
./manage.py apply
./manage.py status --check-nginx
./dc config
./dc ps
```

Most mutation commands already render and narrowly reload. Use supported `--no-reload` flags for a batch, then `apply`.

## Guardrails

- Never edit `runtime/generated/*` or generated managed-version Compose fragments.
- Use `app config customize <app> vhost|pool` for app-owned templates; preserve required identity, socket, TLS, and access-log template structure.
- Put local Compose changes in `compose.override.yml`, `compose.local.yml`, or non-managed `compose.d/*`; verify `./dc config` after overriding volume lists.
- Test Nginx with `./dc exec -T nginx nginx -t` before manual reloads.
- Test FPM with `./dc exec -T php85 php-fpm -tt` after pool/image changes.
- Keep `SOCKET_GID=101` unless Nginx's worker GID changes in lockstep.
- Do not expose MySQL or Redis ports without explicit security review.
- Do not commit `.env`, app credentials, dumps, cert keys, ACME state, runtime state, or app homes.
- Startup synchronizes identities only. Use `permissions check`, a recursive dry-run, then explicit repair for imported/drifted trees.

## Troubleshooting baseline

```bash
./manage.py status --check-nginx
./dc ps
./dc logs --tail=200 nginx
./dc logs --tail=200 php85
./dc logs --tail=200 php85-runner
./dc logs --tail=200 mysql84
ls -l runtime/run/php-fpm/php85/
./manage.py permissions check <app>
```

Read `references/deploy-runbook.md` for symptom-specific checks.
