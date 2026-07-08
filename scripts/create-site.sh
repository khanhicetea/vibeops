#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

usage() {
  cat >&2 <<'USAGE'
Usage: ./scripts/create-site.sh <username> <domain> [db_name] [--php 8.4]

Env:
  ALTER_DOMAINS=www.example.com,alias.example.com
  DEFAULT_PHP_VERSION=8.4
  SITE_INDEX=0       do not create starter index.php

Examples:
  ./scripts/create-site.sh myuser example.com app
  ./scripts/create-site.sh myuser example.com --php 8.5
USAGE
}

php_service_for() {
  local version="$1"
  printf 'php%s' "${version//./}"
}

USERNAME=""
MAIN_DOMAIN=""
DB_NAME="${DB_NAME:-}"
PHP_VERSION="${DEFAULT_PHP_VERSION:-8.4}"
ALTER_DOMAINS="${ALTER_DOMAINS:-}"

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
      elif [[ -z "$MAIN_DOMAIN" ]]; then
        MAIN_DOMAIN="$1"
      elif [[ -z "$DB_NAME" ]]; then
        DB_NAME="$1"
      else
        echo "Unknown argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$USERNAME" && -n "$MAIN_DOMAIN" ]] || { usage; exit 1; }
[[ "$USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "Invalid username: $USERNAME" >&2; exit 1; }
[[ "$MAIN_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid domain: $MAIN_DOMAIN" >&2; exit 1; }
[[ "$PHP_VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "Invalid PHP version: $PHP_VERSION" >&2; exit 1; }
if [[ -n "$DB_NAME" && ! "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Invalid db_name: $DB_NAME" >&2
  exit 1
fi

PHP_SERVICE="$(php_service_for "$PHP_VERSION")"

if [[ ! -f "php/$PHP_VERSION/users.d/$USERNAME.env" ]]; then
  echo "PHP $PHP_VERSION user $USERNAME does not exist; creating it first."
  CREATE_MYSQL_USER="${CREATE_MYSQL_USER:-1}" ./scripts/create-user.sh "$USERNAME" --php "$PHP_VERSION"
fi

SERVER_NAMES="$MAIN_DOMAIN $(printf '%s' "$ALTER_DOMAINS" | tr ',' ' ')"
SITE_ROOT="home/$USERNAME/$MAIN_DOMAIN"
CONF_PATH="nginx/conf.d/$MAIN_DOMAIN.conf"
TEMPLATE="nginx/templates/site.conf.template"

mkdir -p "$SITE_ROOT" "home/$USERNAME/logs"

if [[ "${SITE_INDEX:-1}" != "0" && ! -f "$SITE_ROOT/index.php" ]]; then
  cat > "$SITE_ROOT/index.php" <<PHP
<?php
echo "OK: $MAIN_DOMAIN on PHP $PHP_VERSION\n";
PHP
fi

export USERNAME MAIN_DOMAIN SERVER_NAMES PHP_SERVICE
python3 - "$TEMPLATE" "$CONF_PATH" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for key in ("USERNAME", "MAIN_DOMAIN", "SERVER_NAMES", "PHP_SERVICE"):
    text = text.replace(f"__{key}__", os.environ[key])
open(dst, "w").write(text)
PY

echo "Created HTTP+HTTPS vhost with default self-signed cert: vibeops/$CONF_PATH"
echo "To enable real NGINX ACME later, edit $CONF_PATH and switch the marked TLS block."
echo "Document root: vibeops/$SITE_ROOT"
echo "PHP-FPM: $PHP_VERSION via /run/php-fpm/$PHP_SERVICE/$USERNAME.sock"

if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx "$PHP_SERVICE"; then
  docker compose exec -T "$PHP_SERVICE" php-user-sync "$USERNAME"
fi

if [[ -n "$DB_NAME" ]]; then
  if [[ -f .env ]] && command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx mysql; then
    DB_FULL_NAME="${USERNAME}_${DB_NAME}"

    docker compose exec -T mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_FULL_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${USERNAME}\_%\`.* TO '${USERNAME}'@'%';
FLUSH PRIVILEGES;
SQL
    echo "MySQL database: $DB_FULL_NAME"
  else
    echo "Skipped database creation; mysql is not running or .env is missing."
  fi
fi

if command -v docker >/dev/null 2>&1 && docker compose ps --services --filter status=running 2>/dev/null | grep -qx nginx; then
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  echo "Reloaded nginx"
else
  echo "nginx container is not running; start it then run: docker compose exec nginx nginx -s reload"
fi
