#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

usage() {
  cat >&2 <<'USAGE'
Usage: ./scripts/create-user.sh <username> [uid] [--php 8.4]

Creates a persisted PHP-FPM Linux user/pool for one PHP version:
  home/<username>/
  php/<php-version>/users.d/<username>.env
  php/<php-version>/pool.d/<username>.conf

Examples:
  ./scripts/create-user.sh myuser
  ./scripts/create-user.sh myuser --php 8.5
  ./scripts/create-user.sh myuser 10042 --php 8.4

Env:
  DEFAULT_PHP_VERSION=8.4      default when --php is omitted
  MYSQL_USER_PASSWORD=<pass>   optional; generated if missing
  CREATE_MYSQL_USER=0          skip MySQL user creation
USAGE
}

php_service_for() {
  local version="$1"
  printf 'php%s' "${version//./}"
}

USERNAME=""
USER_UID=""
PHP_VERSION="${DEFAULT_PHP_VERSION:-8.4}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --php|--php-version)
      PHP_VERSION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$USERNAME" ]]; then
        USERNAME="$1"
      elif [[ -z "$USER_UID" ]]; then
        USER_UID="$1"
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$USERNAME" ]] || { usage; exit 1; }
[[ "$USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "Invalid username: $USERNAME" >&2; exit 1; }
[[ "$PHP_VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "Invalid PHP version: $PHP_VERSION" >&2; exit 1; }

PHP_SERVICE="$(php_service_for "$PHP_VERSION")"
SOCKET_GROUP_NAME="${SOCKET_GROUP_NAME:-nginxsock}"

if [[ -z "$USER_UID" ]]; then
  existing_uid=""
  for file in php/*/users.d/$USERNAME.env; do
    existing_uid="$(awk -F= '$1 == "UID" { print $2; exit }' "$file")"
    [[ -n "$existing_uid" ]] && break
  done

  if [[ -n "$existing_uid" ]]; then
    USER_UID="$existing_uid"
  else
    all_env=(php/*/users.d/*.env)
    if [[ ${#all_env[@]} -gt 0 ]]; then
      max_uid="$(awk -F= '/^UID=/{ if ($2 > max) max=$2 } END { print max+0 }' "${all_env[@]}")"
    else
      max_uid=0
    fi
    if [[ -z "$max_uid" || "$max_uid" -lt 10000 ]]; then
      USER_UID=10000
    else
      USER_UID=$((max_uid + 1))
    fi
  fi
fi
[[ "$USER_UID" =~ ^[0-9]+$ ]] || { echo "UID must be numeric" >&2; exit 1; }

mkdir -p \
  "home/$USERNAME/logs" \
  "php/$PHP_VERSION/users.d" \
  "php/$PHP_VERSION/pool.d" \
  "php/$PHP_VERSION/cron.d" \
  "run/php-fpm/$PHP_SERVICE" \
  "logs/php/$PHP_SERVICE"

if [[ ! -f "php/$PHP_VERSION/pool.d/zz-health.conf" ]]; then
  cat > "php/$PHP_VERSION/pool.d/zz-health.conf" <<EOF
[health]
user = www-data
group = $SOCKET_GROUP_NAME
listen = /run/php-fpm/health.sock
listen.owner = www-data
listen.group = $SOCKET_GROUP_NAME
listen.mode = 0660
pm = static
pm.max_children = 1
clear_env = no
EOF
fi

cat > "php/$PHP_VERSION/users.d/$USERNAME.env" <<EOF
USERNAME=$USERNAME
UID=$USER_UID
EOF

cat > "php/$PHP_VERSION/pool.d/$USERNAME.conf" <<EOF
[$USERNAME]
user = $USERNAME
group = $SOCKET_GROUP_NAME

listen = /run/php-fpm/$USERNAME.sock
listen.owner = $USERNAME
listen.group = $SOCKET_GROUP_NAME
listen.mode = 0660

pm = dynamic
pm.max_children = 16
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 256

request_terminate_timeout = 60s
request_slowlog_timeout = 10s
slowlog = /home/$USERNAME/logs/fpm-php-$PHP_VERSION.slow.log
php_flag[display_errors] = off
php_admin_flag[log_errors] = on
php_admin_value[error_log] = /home/$USERNAME/logs/fpm-php-$PHP_VERSION.error.log
php_admin_value[open_basedir] = /home/$USERNAME/:/tmp/:/usr/local/lib/php/:/var/log/php/

clear_env = no
catch_workers_output = yes
EOF

chmod 0750 "home/$USERNAME" || true
chmod 0770 "home/$USERNAME/logs" || true

echo "Created PHP $PHP_VERSION user config: $USERNAME uid=$USER_UID"
echo "Home: docker-stack/home/$USERNAME"
echo "Pool: docker-stack/php/$PHP_VERSION/pool.d/$USERNAME.conf"
echo "Socket: docker-stack/run/php-fpm/$PHP_SERVICE/$USERNAME.sock"

if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx "$PHP_SERVICE"; then
  docker compose exec -T "$PHP_SERVICE" php-user-sync "$USERNAME"
  docker compose exec -T "$PHP_SERVICE" php-fpm -tt
  docker compose exec -T "$PHP_SERVICE" sh -lc 'if command -v s6-svc >/dev/null 2>&1 && [ -e /run/service/php-fpm ]; then s6-svc -2 /run/service/php-fpm; else kill -USR2 1; fi'
  echo "Reloaded $PHP_SERVICE"
else
  echo "$PHP_SERVICE is not running; run/restart it to create the Linux user inside that PHP container."
fi

if [[ "${CREATE_MYSQL_USER:-1}" != "0" ]]; then
  if [[ -f .env ]] && command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx mysql; then
    MYSQL_USER_PASSWORD="${MYSQL_USER_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)}"
    mkdir -p "home/$USERNAME/.credentials"
    cat > "home/$USERNAME/.credentials/mysql.env" <<EOF
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_DATABASE_PREFIX=${USERNAME}_
MYSQL_USER=$USERNAME
MYSQL_PASSWORD=$MYSQL_USER_PASSWORD
EOF
    chmod 0700 "home/$USERNAME/.credentials" || true
    chmod 0600 "home/$USERNAME/.credentials/mysql.env" || true

    docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${USERNAME}'@'%' IDENTIFIED BY '${MYSQL_USER_PASSWORD}';
ALTER USER '${USERNAME}'@'%' IDENTIFIED BY '${MYSQL_USER_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${USERNAME}\_%\`.* TO '${USERNAME}'@'%';
FLUSH PRIVILEGES;
SQL
    echo "MySQL account: $USERNAME / $MYSQL_USER_PASSWORD"
    echo "Saved: docker-stack/home/$USERNAME/.credentials/mysql.env"
  else
    echo "Skipped MySQL user creation; start mysql and rerun, or set CREATE_MYSQL_USER=0."
  fi
fi
