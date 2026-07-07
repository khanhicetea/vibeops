# Docker LEMP Stack Deploy Runbook

This runbook is written for agents and developers operating this repository.

## Repository map

| Path | Purpose |
| --- | --- |
| `compose.yml` | Defines Nginx, PHP-FPM versions, MySQL, Redis, optional node toolbox, volumes, backend network |
| `.env.example` | Required environment defaults; copy to `.env` and set `MYSQL_ROOT_PASSWORD` |
| `home/<user>/<domain>` | Application files and document roots |
| `home/<user>/logs` | Per-user PHP-FPM slow/error logs |
| `nginx/conf.d` | Global Nginx config plus generated vhosts |
| `nginx/templates` | Templates used by `create-site.sh` and `create-proxy.sh` |
| `nginx/snippets` | Shared Nginx security, PHP, proxy, ACME snippets |
| `nginx/acme-state` | NGINX ACME module state; contains sensitive account/cert key material |
| `nginx/self-signed` | Boot certificate so HTTPS config loads before real certs |
| `certs` | Optional external Let's Encrypt-style certificate mount |
| `php/<version>/users.d` | Generated PHP container user definitions |
| `php/<version>/pool.d` | Generated PHP-FPM pool configs |
| `run/php-fpm/phpXX` | Shared Unix sockets between PHP-FPM and Nginx |
| `mysql/conf.d/z-custom.cnf` | MySQL custom config |
| `redis/Dockerfile` | Redis image customization |
| `scripts/create-user.sh` | Creates user home, PHP-FPM user env, pool config, optional MySQL user |
| `scripts/create-site.sh` | Creates site root, generated Nginx vhost, optional MySQL database |
| `scripts/create-proxy.sh` | Creates generated Nginx reverse-proxy vhost |
| `scripts/acme.sh` | Switches generated vhost between self-signed and NGINX ACME |
| `scripts/use-cert.sh` | Switches generated vhost to explicit certificate files |

## Preflight checklist

```bash
pwd
[ -f compose.yml ] && [ -f scripts/create-site.sh ] && echo "stack root OK"
[ -f .env ] || cp .env.example .env
# Edit .env: MYSQL_ROOT_PASSWORD must not be the placeholder.
docker compose config >/tmp/docker-stack.compose.checked.yml
docker compose ps
```

Host checks for production Linux servers:

```bash
ss -ltnp '( sport = :80 or sport = :443 )' || true
ss -lunp '( sport = :443 )' || true
```

If another host service owns 80/443, stop it before starting the host-network Nginx container.

## Bootstrap from fresh clone

```bash
cp .env.example .env
${EDITOR:-vi} .env

docker compose build php84 php85 redis
docker compose up -d mysql redis php84 php85 nginx
docker compose ps
docker compose exec -T nginx nginx -t
```

Expected services by default:

- `nginx`: host network, no `ports:` entries.
- `php84`, `php85`: backend network, write sockets to `run/php-fpm/php84` and `run/php-fpm/php85`.
  - The PHP image build installs OPcache only when `php -m` shows it is absent, so PHP 8.5 can use built-in Zend OPcache without reinstalling it.
- `mysql`: backend network only, named volume `mysql-data`.
- `redis`: backend network only, named volume `redis-data`.

## Deploy a PHP app quickly

1. Create/sync the PHP-FPM user and pool:

   ```bash
   ./scripts/create-user.sh appuser --php 8.5
   ```

2. Put code at:

   ```text
   home/appuser/example.com/
   ```

3. Generate vhost and optional DB:

   ```bash
   ALTER_DOMAINS=www.example.com ./scripts/create-site.sh appuser example.com app --php 8.5
   ```

4. Configure app environment:

   ```text
   DB_HOST=mysql
   DB_PORT=3306
   DB_DATABASE=appuser_app
   DB_USERNAME=appuser
   DB_PASSWORD=<see home/appuser/.credentials/mysql.env if create-user generated it>
   REDIS_HOST=redis
   REDIS_PORT=6379
   ```

5. Validate and reload:

   ```bash
   docker compose exec -T nginx nginx -t
   docker compose exec -T nginx nginx -s reload
   ```

6. Enable real TLS once DNS resolves to this server:

   ```bash
   ./scripts/acme.sh example.com
   ```

## Deploy a reverse-proxied app

For a host process bound to port `3000`:

```bash
ALTER_DOMAINS=www.example.com ./scripts/create-proxy.sh app.example.com http://127.0.0.1:3000
./scripts/acme.sh app.example.com
```

For a service reachable from the Nginx host network by a private IP:

```bash
./scripts/create-proxy.sh app.example.com http://10.0.0.25:3000
```

Generated proxy vhosts include both HTTP and HTTPS. They start with self-signed TLS until switched.

## TLS operations

### NGINX ACME module

Global issuer config is in `nginx/conf.d/00-nginx.conf`:

```nginx
acme_issuer letsencrypt {
    uri https://acme-v02.api.letsencrypt.org/directory;
    challenge http-01;
    state_path /var/cache/nginx/acme-letsencrypt;
    accept_terms_of_service;
}
```

Enable per generated vhost:

```bash
./scripts/acme.sh example.com
```

Disable and return to self-signed:

```bash
./scripts/acme.sh example.com --off
```

ACME HTTP-01 requires:

- DNS A/AAAA points to this server.
- Port 80 is reachable from the public internet.
- Generated vhost has not had its TLS marker block removed.
- `nginx/acme-state/` is writable by the container and persisted.

### External certificate files

Place certs under `certs/live/<domain>/` on the host so Nginx sees:

```text
/etc/letsencrypt/live/<domain>/fullchain.pem
/etc/letsencrypt/live/<domain>/privkey.pem
```

Then run:

```bash
./scripts/use-cert.sh example.com
```

## Common changes

### Add another PHP version

1. Copy an existing PHP service in `compose.yml` and change both the service suffix (`phpXX`) and PHP version directory (`8.x`) consistently.
2. Create matching directories:

   ```bash
   mkdir -p php/8.x/{pool.d,users.d} run/php-fpm/phpXX logs/php/phpXX
   ```

3. Build and start:

   ```bash
   docker compose build phpXX
   docker compose up -d phpXX
   ```

4. Create user/site with `--php 8.x`.

### Change a site's PHP version

```bash
./scripts/create-user.sh appuser --php 8.4
./scripts/create-site.sh appuser example.com --php 8.4
grep -n "fastcgi_pass" nginx/conf.d/example.com.conf
docker compose exec -T nginx nginx -t && docker compose exec -T nginx nginx -s reload
```

## Troubleshooting

### Nginx will not start

```bash
docker compose logs --tail=200 nginx
docker compose exec -T nginx nginx -t
ss -ltnp '( sport = :80 or sport = :443 )' || true
ss -lunp '( sport = :443 )' || true
```

Likely causes:

- Host port conflict with host Nginx/Apache/Caddy.
- Invalid generated vhost syntax.
- Missing self-signed cert files in `nginx/self-signed/`.
- Removed TLS marker block broke helper scripts, though Nginx may still parse.

### PHP returns 502 or socket missing

```bash
ls -l run/php-fpm/php85/
docker compose logs --tail=200 php85
docker compose exec -T php85 php-fpm -tt
docker compose exec -T php85 php-user-sync appuser
docker compose exec -T php85 sh -lc 'kill -USR2 1'
```

Likely causes:

- User was created for another PHP version.
- `fastcgi_pass` points to the wrong `phpXX` socket directory.
- PHP-FPM pool config has invalid syntax.
- Socket group/GID mismatch; default should be `SOCKET_GID=101`.

### Static files 403/404

```bash
namei -l home/appuser/example.com
find home/appuser/example.com -maxdepth 2 -type f -ls | head
```

Nginx needs group-readable files and executable directories through the path. The PHP `php-user-sync` helper normally fixes ownership and group read/execute when `FIX_HOME_OWNERSHIP=1`.

### MySQL connection fails from PHP

Use Compose DNS host `mysql`, not `localhost` or `127.0.0.1`.

```bash
docker compose exec -T mysql mysqladmin -uroot -p"$MYSQL_ROOT_PASSWORD" ping
cat home/appuser/.credentials/mysql.env 2>/dev/null || true
```

The user gets grants on databases matching `<username>_%`.

### Redis connection fails from PHP

Use `redis:6379`, not `localhost`.

```bash
docker compose logs --tail=100 redis
docker compose exec -T redis redis-cli ping
```

### ACME does not issue

```bash
dig +short example.com A
dig +short example.com AAAA
curl -I http://example.com/
docker compose logs --tail=200 nginx
docker compose exec -T nginx nginx -T | grep -n "acme_certificate\|server_name example.com"
```

Common causes:

- DNS has not propagated or points elsewhere.
- Port 80 blocked by firewall/security group.
- Vhost not generated for the requested domain/alias.
- Rate limits from repeated production attempts. Consider changing issuer to staging temporarily in `nginx/conf.d/00-nginx.conf` for tests.

## Safe edit rules for agents

- Prefer invoking existing scripts instead of hand-writing generated config.
- If changing generated vhost behavior, edit templates and explain existing vhosts may need regeneration.
- Preserve data volumes and user content; never delete `home/`, `mysql-data`, `redis-data`, `backups/`, `certs/`, or `nginx/acme-state/` unless explicitly requested.
- Treat credentials and certificates as secrets.
- After config edits, run the narrowest validation command available.
