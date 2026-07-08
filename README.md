# VibeOps — vibe-coding ops stack

VibeOps is a Docker-based LEMP operations stack for vibe-coding workflows, with host-network Nginx, Unix-socket PHP-FPM, multi PHP versions, MySQL, Redis, cron, and ACME-ready TLS.

It is optimized for production performance and DX while keeping the familiar structure:

```text
/home/<user>/<domain>
```

In this stack that maps to:

```text
vibeops/runtime/home/<user>/<domain>
```

## Architecture

- **Nginx** runs with `network_mode: host`
  - no Docker TCP/UDP port publishing
  - no bridge NAT for public HTTP/HTTPS traffic
  - binds directly to host `:80` / `:443` TCP and `:443` UDP for HTTP/3
- **Multiple PHP-FPM versions** run as separate Debian Trixie-based containers:
  - `php84` from `php:8.4-fpm-trixie`
  - `php85` from `php:8.5-fpm-trixie`
  - OPcache is installed only when `php -m` shows it is missing, so PHP 8.5 can use its built-in Zend OPcache without reinstalling it.
- **PHP-FPM exposes per-user Unix sockets** in versioned shared dirs:
  - host path: `vibeops/runtime/run/php-fpm/php84/<user>.sock`
  - nginx path: `/run/php-fpm/php84/<user>.sock`
  - PHP container path: `/run/php-fpm/<user>.sock`
- **Each PHP-FPM pool is a Linux user** inside each PHP container:
  - user home: `/home/<user>`
  - sites: `/home/<user>/<domain>`
  - logs: `/home/<user>/logs`
- **PHP runtime is split by role** while sharing the same PHP image/version:
  - `php84` / `php85` run PHP-FPM only and expose sockets
  - `php84-cron` / `php85-cron` run supercronic only
  - `php84-cli` / `php85-cli` are ephemeral deploy/shell services
  - deploy commands, Composer, cron, and PHP-FPM still use the same PHP binary/extensions
- **PHP connects to MySQL/Redis** over the Compose backend network:
  - MySQL host: `mysql:3306`
  - Redis host: `redis:6379`
- **Nginx reads site files from `/home` read-only** and talks to PHP by Unix sockets.
- **The official NGINX ACME module is enabled** with HTTP-01.
  - Generated vhosts always include both HTTP and HTTPS.
  - HTTPS starts with a default self-signed cert so Nginx can boot before DNS/ACME is ready.
  - When ready, edit the marked TLS block in the vhost to switch from self-signed to ACME.
  - ACME state is persisted in `runtime/nginx-acme-state/`.

## Layout

```text
compose.yml
.env.example
manage.py                     # create users/sites/crons and run app commands
docs/architecture.md          # current file-layout/architecture notes

docker/                       # Docker build contexts and image helper binaries
config/                       # committed stack config and templates
  nginx/                      # Nginx global config, snippets, templates, self-signed cert
  php/                        # PHP common config, versioned users/pools, templates
  mysql/                      # MySQL config and SQL templates
runtime/                      # mutable/generated/live data
  home/                       # /home bind mount for user sites
  run/php-fpm/php84/          # PHP 8.4 sockets
  run/php-fpm/php85/          # PHP 8.5 sockets
  nginx/vhosts/               # generated vhosts
  nginx-acme-state/           # NGINX ACME account/cert/private-key state
  cron/php84/jobs/            # generated PHP 8.4 cron jobs
  cron/php85/jobs/            # generated PHP 8.5 cron jobs
  logs/                       # nginx/php logs
  certs/                      # externally managed cert files
  backups/                    # backups/dumps
```

## Quick start

```bash
cd vibeops
cp .env.example .env
# edit MYSQL_ROOT_PASSWORD

docker compose build php84 php85 php84-cron php85-cron
docker compose up -d mysql redis php84 php85 php84-cron php85-cron nginx
```

## Interactive DX

For guided operations, run the no-dependency Python wizard:

```bash
./manage.py
# or explicitly:
./manage.py wizard
./manage.py tui
```

The wizard can create users, PHP sites, proxy vhosts, TLS/ACME config, cron jobs, open app shells, and show stack status. It previews the plan before applying changes and prints equivalent CLI commands for common flows.

For a quick dashboard without entering the wizard:

```bash
./manage.py status
./manage.py status --check-nginx
```

## Create a PHP-FPM user/pool

Default PHP version comes from `.env` `DEFAULT_PHP_VERSION`.

```bash
./manage.py user create myuser
```

Create the same user for a specific PHP version:

```bash
./manage.py user create myuser --php 8.5
```

This creates, for example:

```text
runtime/home/myuser/
config/php/versions/8.5/users.d/myuser.env
config/php/versions/8.5/pool.d/myuser.conf
runtime/run/php-fpm/php85/myuser.sock   # appears after php85 reload/start
```

The same username reuses the same numeric UID across PHP versions.

## Create a site and choose PHP version

Generated sites always include both HTTP and HTTPS in one vhost file. HTTPS uses the default self-signed certificate until you switch the marked TLS block to real ACME.

```bash
./manage.py site create myuser example.com app --php 8.5 --alias www.example.com
```

This creates:

```text
runtime/home/myuser/example.com/
runtime/nginx/vhosts/example.com.conf
```

The generated Nginx vhost uses the selected PHP socket:

```nginx
fastcgi_pass unix:/run/php-fpm/php85/myuser.sock;
```

The optional DB argument, `app`, creates:

```text
myuser_app
```

PHP app connection values:

```text
DB_HOST=mysql
DB_PORT=3306
DB_DATABASE=myuser_app
DB_USERNAME=myuser
REDIS_HOST=redis
REDIS_PORT=6379
```

## Deploy app code and run Composer

Run app commands in an ephemeral matching PHP CLI container as the same Linux user used by PHP-FPM:

```bash
./manage.py shell
# or explicitly:
./manage.py shell myuser example.com --php 8.5
./manage.py exec myuser example.com --php 8.5 -- git clone git@github.com:org/project.git .
./manage.py exec myuser example.com --php 8.5 -- composer install
./manage.py exec myuser example.com --php 8.5 -- php artisan migrate
```

Use `SITE_INDEX=0` for existing projects so the directory is empty before `git clone ... .`. This keeps Git, Composer, PHP-FPM, and generated files on the same UID/GID. SSH deploy keys can live in `runtime/home/myuser/.ssh/` with normal SSH permissions.

## Cron jobs

Cron runs in separate `php84-cron` / `php85-cron` containers. Create cron jobs per PHP version:

```bash
./manage.py cron create myuser example.com schedule '* * * * *' 'php artisan schedule:run' --php 8.5
```

This writes:

```text
runtime/cron/php85/jobs/myuser-example.com-schedule.cron
runtime/cron/php85/.supercronic.cron
```

The job runs in the `php85-cron` container as `myuser`, from `/home/myuser/example.com`, with the PHP 8.5 binary/extensions and the same container environment as PHP-FPM. `manage.py` merges `jobs/*.cron` files into `runtime/cron/php85/.supercronic.cron` and reloads Supercronic with `SIGUSR2`; if the cron container was idle before the first job, `manage.py` restarts it once to start Supercronic. Do not scale a cron service to multiple replicas, or jobs will run more than once.

## Change a site's PHP version

Re-run `manage.py site create` with another `--php` version. It regenerates the Nginx vhost and reloads Nginx if running:

```bash
./manage.py user create myuser --php 8.4
./manage.py site create myuser example.com --php 8.4
```

## TLS certificates

The NGINX ACME module is loaded and configured globally:

- issuer: Let's Encrypt production directory
- challenge: HTTP-01
- persisted state: `runtime/nginx-acme-state/` mounted at `/var/cache/nginx/acme-letsencrypt`

Generated vhosts start with this active self-signed block:

```nginx
ssl_certificate /etc/nginx/self-signed/default.crt;
ssl_certificate_key /etc/nginx/self-signed/default.key;

# acme_certificate letsencrypt;
# ssl_certificate $acme_certificate;
# ssl_certificate_key $acme_certificate_key;
```

When DNS is ready, enable real ACME and reload Nginx automatically:

```bash
./manage.py tls acme example.com
```

To switch back to the boot self-signed cert:

```bash
./manage.py tls acme example.com --off
```

`runtime/nginx-acme-state/` contains private keys after first issuance; keep it backed up and private. To change issuer settings, edit `config/nginx/global/00-nginx.conf`.

If you need to use externally managed certificate files instead, place them under `runtime/certs/` using the usual Let's Encrypt layout:

```text
runtime/certs/live/example.com/fullchain.pem
runtime/certs/live/example.com/privkey.pem
```

Then switch an existing generated vhost to file-based certs:

```bash
./manage.py tls cert example.com
```

Or pass explicit paths as seen inside the Nginx container:

```bash
./manage.py tls cert example.com \
  --cert /etc/letsencrypt/live/example.com/fullchain.pem \
  --key /etc/letsencrypt/live/example.com/privkey.pem
```

## Add another PHP version

Copy an existing PHP service in `compose.yml` and change both the service suffix (`phpXX`) and PHP version directory (`8.x`) consistently:

```yaml
  phpXX:
    <<: *php-common
    build:
      context: ./docker/php
      args:
        PHP_VERSION: 8.x
        TZ: ${TZ:-Asia/Ho_Chi_Minh}
    volumes:
      - ./runtime/home:/home
      - ./runtime/run/php-fpm/phpXX:/run/php-fpm
      - ./runtime/logs/php/phpXX:/var/log/php
      - ./config/php/common/conf.d/90-custom.ini:/usr/local/etc/php/conf.d/90-custom.ini:ro
      - ./config/php/versions/8.x/pool.d:/usr/local/etc/php-fpm.d/pools:ro
      - ./config/php/versions/8.x/users.d:/usr/local/etc/php/users.d:ro
      - ./runtime/cron/phpXX:/usr/local/etc/php/cron.d:ro
```

Then:

```bash
mkdir -p config/php/versions/8.x/{pool.d,users.d} runtime/cron/phpXX/jobs runtime/run/php-fpm/phpXX runtime/logs/php/phpXX
docker compose build phpXX
docker compose up -d phpXX
./manage.py user create myuser --php 8.x
./manage.py site create myuser example.com --php 8.x
```

## Important permission detail

The official Debian-based Nginx image runs workers as GID `101`. PHP-FPM sockets are created with `SOCKET_GID=101` via `.env`, so Nginx can access them across containers. Site files are group-readable so Nginx can serve static assets directly.

For very large `/home/<user>` directories you can disable automatic recursive ownership fixes:

```env
FIX_HOME_OWNERSHIP=0
```

Then manage ownership yourself.

## Performance choices

- Host networking for Nginx removes Docker port-map/NAT overhead.
- Unix sockets between Nginx and PHP-FPM avoid local TCP overhead.
- Versioned socket directories avoid conflicts between PHP versions.
- Nginx serves static files directly from a read-only `/home` mount.
- HTTP/3 (QUIC) is enabled on generated HTTPS vhosts.
- Global `proxy_cache` and `fastcgi_cache` zones are declared for vhosts to opt in.
- PHP, MySQL, Redis stay isolated on a Compose backend network.
- MySQL/Redis are not exposed with host ports by default.

## Notes

- This stack targets Linux cloud servers. Docker Desktop host networking and Unix socket bind mounts can behave differently.
- Make sure host firewalls/security groups allow UDP/443 if you want HTTP/3 to be reachable.
- Keep existing Ansible for host bootstrap/security/Docker install; avoid installing host Nginx/PHP/MySQL/Redis for new servers.
