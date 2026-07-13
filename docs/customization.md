# Customization

bento keeps upstream files separate from local changes so upgrades remain reviewable.

```text
Do edit:     .env, Compose overrides, runtime/custom/, state through manage.py
Do not edit: runtime/generated/, generated bento version fragments, core files for local-only changes
```

## Environment settings

Copy `.env.example` to `.env` and keep it untracked. It contains secrets and defaults such as:

```env
TZ=Asia/Ho_Chi_Minh
MYSQL_ROOT_PASSWORD=<long-random-password>
DEFAULT_MYSQL_SERVICE=mysql84
DEFAULT_PHP_VERSION=8.5
DEFAULT_FPM_PROFILE=balanced
SOCKET_GID=101
REDIS_APP_ACL=false
REDIS_PASSWORD=<long-random-password>
```

Changing `PHP_FPM_PROCESS_MAX` requires rebuilding managed PHP images. Changing a MySQL root password requires `./manage.py render` and recreation of the affected MySQL container so its mounted root option file and environment stay aligned.

## Compose overrides

Put local Compose changes in one of:

```text
compose.override.yml
compose.local.yml
compose.d/<name>.yml
compose.d/<name>.yaml
```

Do not edit `config/compose.yml` unless maintaining a fork. Always operate through `./dc` or `./manage.py compose` so all fragments load:

```bash
./dc config
./dc up -d
./dc logs -f nginx
```

Example Redis memory limit:

```yaml
# compose.override.yml
services:
  redis:
    deploy:
      resources:
        limits:
          memory: 256M
```

Example custom PHP ini for all PHP 8.5 roles:

```yaml
services:
  php85:
    volumes:
      - ./runtime/custom/php/8.5/conf.d:/usr/local/etc/php/conf.d/custom:ro
  php85-runner:
    volumes:
      - ./runtime/custom/php/8.5/conf.d:/usr/local/etc/php/conf.d/custom:ro
  php85-cli:
    volumes:
      - ./runtime/custom/php/8.5/conf.d:/usr/local/etc/php/conf.d/custom:ro
```

Create `runtime/custom/php/8.5/conf.d/99-local.ini`:

```ini
memory_limit = 512M
upload_max_filesize = 128M
post_max_size = 128M
```

If the application needs the setting during web requests, deployments, cron, and workers, apply the mount to FPM, CLI, and runner roles.

Compose may replace lists rather than append them as expected. After overriding `volumes`, inspect `./dc config` and verify the core `/home`, generated PHP config, runner config, socket, and log mounts remain present.

## State-managed changes

Use CLI commands rather than editing `runtime/state/stack.json` manually:

```bash
./manage.py app create shop shop.example.com app --public-dir public
./manage.py app domain add shop www.shop.example.com
./manage.py proxy create api.example.com http://127.0.0.1:3000
./manage.py cron create shop scheduler '* * * * *' 'php artisan schedule:run'
./manage.py worker create shop queue -- php artisan queue:work
./manage.py tls acme shop.example.com
```

These commands render and narrowly validate/reload their affected services. For a planned batch, use `--no-reload` where available and finish with:

```bash
./manage.py apply
```

## App-owned Nginx and FPM templates

Use first-class template customization when one app needs a complete custom vhost or pool:

```bash
./manage.py app config status shop
./manage.py app config customize shop vhost
./manage.py app config customize shop pool
```

The command copies the current upstream template to:

```text
runtime/custom/apps/shop/nginx/vhost.conf.template
runtime/custom/apps/shop/php/pool.conf.template
```

It opens `$VISUAL`, `$EDITOR`, or `vi`, records custom ownership in state, renders transactionally, validates, and reloads the affected service. Automation can use `--no-edit`; `--no-reload` validates without signaling. Use `--force` only to replace an existing custom source with the latest upstream template.

Custom sources are still templates. Preserve:

- required app identity and socket variables in FPM pools
- TLS marker structure and app variables in vhosts
- the access-log conditional if app access logging should work

```nginx
{% if ACCESS_LOG %}
    access_log /var/log/nginx/apps/${APP_NAME}.access.log bento_combined buffer=64k flush=30s;
{% endif %}
```

`app config status` reports whether the upstream template changed since customization. Return to upstream generation without deleting the inactive custom source:

```bash
./manage.py app config reset shop vhost
./manage.py app config reset shop pool
```

Edit the custom source, never its output under `runtime/generated/`. Run `./manage.py apply` after later manual edits.

## General runtime custom files

`runtime/custom/` is ignored local storage for user-owned files:

```text
runtime/custom/apps/   # state-selected app templates
runtime/custom/nginx/  # local Nginx files/images
runtime/custom/php/    # local PHP config
runtime/custom/mysql/  # local MySQL config
```

Only app templates selected through `app config customize` are consumed automatically. Mount or include other files with a Compose override.

Example MySQL config:

```yaml
services:
  mysql84:
    volumes:
      - ./runtime/custom/mysql/mysql84/conf.d:/etc/mysql/conf.d/local:ro
```

```ini
# runtime/custom/mysql/mysql84/conf.d/99-local.cnf
[mysqld]
max_connections = 100
```

Use version-appropriate settings and validate the final service before production deployment.

## Add a local service

```yaml
# compose.d/30-monitoring.yml
services:
  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    restart: unless-stopped
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker:/var/lib/docker:ro
    ports:
      - "127.0.0.1:8080:8080"
```

```bash
./dc config
./dc up -d cadvisor
```

For an optional Nginx image with Brotli and Zstandard modules, see [nginx-br-zstd-optin.md](nginx-br-zstd-optin.md).

## Constraints

### Keep Nginx host-networked

The default ingress assumes `network_mode: host`. Replacing it with bridge `ports:` changes HTTP/3, ACME, host upstreams, and socket/network behavior. Treat that as an ingress redesign, not a local tweak.

### Keep socket paths aligned

```text
host:  runtime/run/php-fpm/phpXX/<app>.sock
nginx: /run/php-fpm/phpXX/<app>.sock
PHP:   /run/php-fpm/<app>.sock
```

Do not change `SOCKET_GID` unless the Nginx worker group and all socket permissions change with it.

### Keep runner replicas at one

Every `phpXX-runner` owns schedules and workers for that PHP version. Scaling it duplicates those processes.

### Keep data private

Do not publish MySQL or Redis ports without a security review. Do not commit `.env`, credentials, cert keys, ACME state, database dumps, or app homes.

## Upgrade workflow

```bash
git pull
./manage.py render
./dc config
./manage.py apply
make check
```

Review custom-template status and merged Compose output after upstream template or topology changes.
