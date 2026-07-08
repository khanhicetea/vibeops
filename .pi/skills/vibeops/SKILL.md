---
name: vibeops
description: Understand and operate this repository's VibeOps, host-network Nginx, multi-version PHP-FPM over Unix sockets, MySQL, Redis, ACME TLS, site/user/proxy creation, deployment checks, and troubleshooting. Use when deploying apps, adding domains, changing PHP versions, editing compose/nginx/php config, or diagnosing production issues in this stack.
---

# VibeOps Skill

Use this skill when working in this `vibeops` repository or helping a developer deploy an app onto it.

## First steps

1. Confirm you are at the stack root: files should include `compose.yml`, `README.md`, `scripts/create-site.sh`, `nginx/`, `php/`, `home/`.
2. Read `README.md` for the canonical overview before changing deployment behavior.
3. For implementation details, read the specific file you will touch:
   - `compose.yml` for service topology, bind mounts, networks, and PHP versions.
   - `scripts/create-user.sh` for PHP-FPM Linux user/pool creation.
   - `scripts/create-site.sh` for PHP vhost generation and DB creation.
   - `scripts/create-proxy.sh` for reverse-proxy vhost generation.
   - `scripts/acme.sh` and `scripts/use-cert.sh` for certificate switching.
   - `nginx/templates/*.template` before changing generated vhost behavior.
4. Use the quick runbook in `references/deploy-runbook.md` for deployment commands and troubleshooting.
5. Optionally run `scripts/deploy-check.sh` from this skill directory for a fast local readiness report:
   ```bash
   .pi/skills/vibeops/scripts/deploy-check.sh
   ```

## Stack mental model

- Nginx uses `network_mode: host`; do **not** add Docker `ports:` for Nginx.
- Public traffic terminates on host ports `80`, `443/tcp`, and `443/udp` directly in the Nginx container.
- PHP-FPM services (`php84`, `php85` by default) are on the Compose `backend` network and expose **Unix sockets**, not TCP ports.
- Socket path mapping:
  - host: `run/php-fpm/php84/<user>.sock` or `run/php-fpm/php85/<user>.sock`
  - nginx: `/run/php-fpm/php84/<user>.sock`
  - PHP container: `/run/php-fpm/<user>.sock`
- Site roots are `home/<user>/<domain>` and are mounted read-only into Nginx but read-write into PHP.
- MySQL and Redis are only reachable from backend containers as `mysql:3306` and `redis:6379`.
- Generated vhosts start with a self-signed cert, then switch to NGINX ACME or explicit cert files.

## Fast deployment workflows

### Bootstrap a new server

```bash
cp .env.example .env
# edit MYSQL_ROOT_PASSWORD and optionally DEFAULT_PHP_VERSION/TZ
docker compose build php84 php85 redis
docker compose up -d mysql redis php84 php85 nginx
docker compose ps
docker compose exec -T nginx nginx -t
```

Before starting Nginx on a real server, ensure no host Nginx/Apache is already bound to ports 80/443.

### Add a PHP site

```bash
./scripts/create-user.sh <user> --php 8.5
ALTER_DOMAINS=www.example.com ./scripts/create-site.sh <user> example.com app --php 8.5
# point DNS A/AAAA to the server, then:
./scripts/acme.sh example.com
```

The optional DB argument `app` creates database `<user>_app`. App connection defaults:

```text
DB_HOST=mysql
DB_PORT=3306
DB_DATABASE=<user>_<db>
DB_USERNAME=<user>
REDIS_HOST=redis
REDIS_PORT=6379
```

### Add a reverse-proxy vhost

```bash
ALTER_DOMAINS=www.example.com ./scripts/create-proxy.sh app.example.com http://127.0.0.1:3000
./scripts/acme.sh app.example.com
```

Because Nginx is host-networked, `127.0.0.1:<port>` refers to the host network namespace.

### Change PHP version for a site

```bash
./scripts/create-user.sh <user> --php 8.4
./scripts/create-site.sh <user> example.com --php 8.4
docker compose exec -T nginx nginx -t && docker compose exec -T nginx nginx -s reload
```

The vhost's `fastcgi_pass` should point to `/run/php-fpm/php84/<user>.sock` or `/run/php-fpm/php85/<user>.sock`.

## Guardrails

- Preserve generated vhost marker comments `# BEGIN TLS_CERTIFICATE` and `# END TLS_CERTIFICATE`; TLS helper scripts depend on them.
- Do not expose MySQL or Redis with host ports unless explicitly asked and security-reviewed.
- Keep `SOCKET_GID=101` unless the Nginx worker GID changes; this is what allows Nginx to open PHP-FPM sockets.
- Do not commit `.env`, live certificates/private keys, database dumps, or generated ACME account state.
- Test Nginx config before reload: `docker compose exec -T nginx nginx -t`.
- Test PHP-FPM config after pool changes: `docker compose exec -T php85 php-fpm -tt`.
- For large homes, consider `FIX_HOME_OWNERSHIP=0` to avoid slow recursive ownership fixes.

## Troubleshooting shortcuts

```bash
docker compose ps
docker compose logs --tail=100 nginx
docker compose logs --tail=100 php85
docker compose exec -T nginx nginx -T | grep -n "example.com\|fastcgi_pass\|ssl_certificate"
ls -l run/php-fpm/php85/
find home/<user>/<domain> -maxdepth 2 -type f -ls | head
```

If you need deeper detail, read `references/deploy-runbook.md`.
