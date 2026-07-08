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
Usage: ./scripts/app-exec.sh <username> <domain> [--php 8.4] [--workdir /path] -- <command...>

Run git/composer/artisan/wp-cli/etc inside the matching PHP container as the
same Linux user used by PHP-FPM.

Examples:
  ./scripts/app-exec.sh myuser example.com --php 8.4 -- composer install
  ./scripts/app-exec.sh myuser example.com --php 8.4 -- php artisan migrate
  ./scripts/app-exec.sh myuser example.com --php 8.4 -- git clone git@github.com:org/project.git .
  ./scripts/app-exec.sh myuser example.com --php 8.4 -- sh
USAGE
}

php_service_for() {
  local version="$1"
  printf 'php%s' "${version//./}"
}

USERNAME=""
DOMAIN=""
PHP_VERSION="${DEFAULT_PHP_VERSION:-8.4}"
WORKDIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --php|--php-version)
      PHP_VERSION="${2:-}"
      shift 2
      ;;
    --workdir|-w)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$USERNAME" ]]; then
        USERNAME="$1"
      elif [[ -z "$DOMAIN" ]]; then
        DOMAIN="$1"
      else
        echo "Unknown argument before --: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

[[ -n "$USERNAME" && -n "$DOMAIN" ]] || { usage; exit 1; }
[[ "$USERNAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "Invalid username: $USERNAME" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid domain/path name: $DOMAIN" >&2; exit 1; }
[[ "$PHP_VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || { echo "Invalid PHP version: $PHP_VERSION" >&2; exit 1; }

if [[ $# -eq 0 ]]; then
  set -- sh
fi

PHP_SERVICE="$(php_service_for "$PHP_VERSION")"
APP_HOME="/home/$USERNAME"
if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$APP_HOME/$DOMAIN"
fi

if [[ ! -f "php/$PHP_VERSION/users.d/$USERNAME.env" ]]; then
  echo "PHP $PHP_VERSION user $USERNAME does not exist; creating it first."
  ./scripts/create-user.sh "$USERNAME" --php "$PHP_VERSION"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! docker compose ps --services --filter status=running 2>/dev/null | grep -qx "$PHP_SERVICE"; then
  echo "$PHP_SERVICE is not running" >&2
  exit 1
fi

# Make sure the container user exists and ownership is synced before dropping privileges.
docker compose exec -T "$PHP_SERVICE" php-user-sync "$USERNAME"

tty_args=()
if [[ ! -t 0 || ! -t 1 ]]; then
  tty_args=(-T)
fi

exec docker compose exec "${tty_args[@]}" \
  -u "$USERNAME" \
  -w "$WORKDIR" \
  -e HOME="$APP_HOME" \
  -e USER="$USERNAME" \
  -e LOGNAME="$USERNAME" \
  -e COMPOSER_HOME="$APP_HOME/.composer" \
  "$PHP_SERVICE" "$@"
