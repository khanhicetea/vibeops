# bento deploy runbook

Use commands from the repository root. Prefer `./dc` over bare `docker compose` so generated and local Compose fragments are included.

## Preflight

```bash
[ -f config/compose.yml ] && [ -x manage.py ] && [ -x dc ] && echo 'stack root OK'
[ -f .env ] || cp .env.example .env
./dc config >/tmp/bento-compose.yml
```

Production host checks:

```bash
ss -ltnp '( sport = :80 or sport = :443 )' || true
ss -lunp '( sport = :443 )' || true
df -h
docker info >/dev/null
```

Nginx needs host ports 80/443. UDP 443 is optional but required for HTTP/3. Review `.env` for long MySQL/Redis passwords and realistic MySQL/Redis memory limits.

## Fresh bootstrap

```bash
cp .env.example .env
${EDITOR:-vi} .env
./manage.py render
./dc up -d --build
./manage.py status --check-nginx
./dc ps
```

Default managed services are `nginx`, `redis`, `mysql84`, `php85`, and `php85-runner`. `php85-cli` is ephemeral and profile-gated.

## Deploy a PHP application

```bash
./manage.py app create shop shop.example.com app \
  --php 8.5 \
  --public-dir public \
  --alias www.shop.example.com

./manage.py exec shop -- git clone git@github.com:org/project.git .
./manage.py exec shop -- composer install --no-dev --optimize-autoloader
./manage.py exec shop -- php artisan migrate --force
./manage.py permissions check shop
```

The example database is `shop_app` on the app's selected MySQL service. Read credentials from:

```text
runtime/home/shop/.credentials/mysql84.env
runtime/home/shop/.credentials/redis.env
```

Typical endpoints inside PHP containers:

```text
DB_HOST=mysql84
DB_PORT=3306
REDIS_HOST=redis
REDIS_PORT=6379
```

After DNS resolves and port 80 is public:

```bash
./manage.py tls acme shop.example.com
./dc exec -T nginx nginx -t
```

## Deploy a host reverse proxy

```bash
./manage.py proxy create api.example.com http://127.0.0.1:3000
./manage.py tls acme api.example.com
```

Because Nginx is host-networked, `127.0.0.1` refers to the host namespace. Ensure the upstream listens on an address reachable there.

## Routine deployment

```bash
git pull
./manage.py render
./dc config
./manage.py apply
./manage.py status --check-nginx
make check
```

Application deployment example:

```bash
./manage.py exec shop -- git pull --ff-only
./manage.py exec shop -- composer install --no-dev --optimize-autoloader
./manage.py exec shop -- php artisan migrate --force
./manage.py exec shop -- php artisan config:cache
./manage.py worker restart shop
```

Adapt application commands to the framework. Take a logical backup before risky migrations.

## Back up and restore

```bash
./manage.py db backup --app shop --zstd --keep 14
./manage.py db list-backups --mysql-service mysql84
```

Restore safely into a new database first:

```bash
./manage.py db restore runtime/backups/mysql84/<dump>.sql.zst \
  --database shop_app \
  --new-suffix recovery
```

Replacing the original requires exact-name confirmation:

```bash
./manage.py db restore runtime/backups/mysql84/<dump>.sql.zst \
  --database shop_app \
  --confirm-database shop_app
```

Copy `runtime/backups/` off-host. Never run `down -v`; it removes MySQL and Redis named volumes.

## Incident baseline

```bash
./manage.py status --check-nginx
./dc ps
./dc logs --tail=200 nginx
./dc logs --tail=200 php85
./dc logs --tail=200 php85-runner
./dc logs --tail=200 mysql84
./dc logs --tail=200 redis
```

Also check disk, memory, and host ports:

```bash
df -h
free -h
ss -ltnp '( sport = :80 or sport = :443 )' || true
ss -lunp '( sport = :443 )' || true
```

## Nginx fails or returns 4xx/5xx

```bash
./dc exec -T nginx nginx -t
./dc exec -T nginx nginx -T | grep -n 'shop.example.com\|fastcgi_pass\|ssl_certificate'
./dc logs --tail=200 nginx
```

Check:

- another host process owns port 80/443
- generated vhost syntax is valid
- selected custom template still contains required TLS/app variables
- self-signed files or selected external cert files exist
- Nginx can traverse the selected public directory

Generated vhosts are under `runtime/generated/nginx/vhosts/`; diagnose them but do not edit them.

## PHP 502 or missing socket

```bash
ls -la runtime/run/php-fpm/php85/
./dc logs --tail=200 php85
./dc exec -T php85 php-fpm -tt
./manage.py app show shop
./manage.py identity sync shop
./manage.py permissions check shop
```

Expected PHP 8.5 socket:

```text
host:  runtime/run/php-fpm/php85/shop.sock
nginx: /run/php-fpm/php85/shop.sock
PHP:   /run/php-fpm/shop.sock
```

Common causes are a stopped/wrong PHP service, invalid pool, mismatched app version, missing identity, or socket GID mismatch. `SOCKET_GID` normally remains `101`.

## Static file 403/404

```bash
namei -l runtime/home/shop/www/public
find runtime/home/shop/www/public -maxdepth 2 -type f -ls | head
./manage.py permissions check shop
./manage.py permissions fix shop --recursive --dry-run
```

Only after reviewing the dry-run:

```bash
./manage.py permissions fix shop --recursive
```

Verify that `public_dir` matches the actual deployment and that secrets are outside the public root.

## MySQL connection failure

```bash
./dc ps mysql84
./dc logs --tail=200 mysql84
./manage.py db shell --mysql-service mysql84
./manage.py app show shop
```

Use the app's recorded service such as `mysql84`, not `localhost`. Confirm its credential file exists and the database name uses the `<app>_<suffix>` form. If MySQL cannot create error/slow logs, inspect ownership of `runtime/logs/mysql84/`.

## Redis connection failure

```bash
./dc ps redis
./dc logs --tail=200 redis
```

Use `redis:6379`, not localhost. Read the app's Redis credential file. In ACL mode, verify `REDIS_ADMIN_PASSWORD`, the app username/password, and the required `<app>:` client key/channel prefix. Changing initial ACL settings may require deliberate Redis recreation; preserve data and understand the impact first.

## Cron or worker failure

```bash
./manage.py cron list --app shop
./manage.py worker list --app shop
./manage.py worker status shop
./dc logs --tail=200 php85-runner
```

Check the app's recorded PHP version, workdir, argv, file permissions, and runner service. A runner restart affects all schedules and workers on that PHP version. Never scale runners above one.

## ACME failure

```bash
dig +short shop.example.com A
dig +short shop.example.com AAAA
curl -I http://shop.example.com/
./dc logs --tail=200 nginx
./dc exec -T nginx nginx -T | grep -n 'acme_certificate\|server_name shop.example.com'
```

Check public DNS, firewall/security-group port 80, domain ownership in state, and Let's Encrypt rate limits. ACME state is under `runtime/nginx-acme-state/` and must be writable and persistent.

## Safe operating rules

- Never edit `runtime/generated/`; change state/templates and render.
- Never delete app homes, state, backups, certs, ACME state, secrets, or named volumes during troubleshooting.
- Never expose MySQL/Redis ports as a quick fix.
- Validate `./dc config` after local overrides, especially volume overrides.
- Validate Nginx/FPM before manual reloads.
- Use app-owned template commands instead of maintaining generated-file patches.
