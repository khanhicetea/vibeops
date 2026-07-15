#!/usr/bin/env bash
set -euo pipefail

is_stack_root() {
  [[ -f "$1/config/compose.yml" \
    && -f "$1/manage.py" \
    && -f "$1/dc" \
    && -d "$1/bento" \
    && -d "$1/config" \
    && -d "$1/runtime" ]]
}

find_stack_root() {
  local dir
  for dir in "$(pwd)" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; do
    while [[ "$dir" != "/" ]]; do
      if is_stack_root "$dir"; then
        printf '%s\n' "$dir"
        return 0
      fi
      dir="$(dirname "$dir")"
    done
  done
  return 1
}

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
ok() { printf 'OK: %s\n' "$*"; }

ROOT="$(find_stack_root || true)"
if [[ -z "${ROOT:-}" ]]; then
  echo "Could not find bento root (config/compose.yml + manage.py + dc + bento/ + config/ + runtime/)." >&2
  exit 1
fi
cd "$ROOT"

say "Stack root"
printf '%s\n' "$ROOT"

say "Required files"
for path in config/compose.yml manage.py dc README.md .env.example docker/php/Dockerfile config/nginx/nginx.conf; do
  if [[ -e "$path" ]]; then ok "$path"; else warn "missing $path"; fi
done
for path in manage.py dc; do
  if [[ -x "$path" ]]; then ok "$path is executable"; else warn "$path is not executable"; fi
done

say "Environment"
if [[ -f .env ]]; then
  ok ".env exists"
  for secret in MYSQL_ROOT_PASSWORD REDIS_PASSWORD; do
    if grep -q "^${secret}=change-me-" .env; then
      warn "$secret is still an example placeholder"
    elif grep -q "^${secret}=." .env; then
      ok "$secret is set"
    else
      warn "$secret is missing or empty in .env"
    fi
  done
  grep -E '^(TZ|DEFAULT_MYSQL_SERVICE|DEFAULT_PHP_VERSION|DEFAULT_FPM_PROFILE|PHP_FPM_PROCESS_MAX|SOCKET_GID|REDIS_APP_ACL)=' .env || true
else
  warn ".env missing; copy .env.example to .env and set production secrets"
fi

say "Host capacity"
command -v df >/dev/null 2>&1 && df -h . || warn "df not available"
command -v free >/dev/null 2>&1 && free -h || warn "free not available"

say "Host port listeners"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp '( sport = :80 or sport = :443 )' || true
  ss -lunp '( sport = :443 )' || true
else
  warn "ss not available; skipping port listener check"
fi

say "Docker Compose config"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose_out="$(mktemp)"
  compose_err="$(mktemp)"
  trap 'rm -f "$compose_out" "$compose_err"' EXIT
  if ./dc config >"$compose_out" 2>"$compose_err"; then
    ok "./dc config is valid"
  else
    warn "./dc config failed:"
    while IFS= read -r line; do printf '  %s\n' "$line" >&2; done <"$compose_err"
  fi

  if docker info >/dev/null 2>&1; then
    say "Docker Compose services"
    ./dc ps || true
    running_services="$(./dc ps --services --filter status=running 2>/dev/null || true)"

    if grep -qx nginx <<<"$running_services"; then
      say "Nginx validation"
      ./dc exec -T nginx nginx -t || warn "nginx -t failed"
    else
      warn "nginx is not running"
    fi

    while IFS= read -r svc; do
      [[ -n "$svc" ]] || continue
      if grep -qx "$svc" <<<"$running_services"; then
        say "$svc validation"
        ./dc exec -T "$svc" php-fpm -tt || warn "$svc php-fpm -tt failed"
        printf 'Sockets in runtime/run/php-fpm/%s:\n' "$svc"
        ls -la "runtime/run/php-fpm/$svc" 2>/dev/null || true
      fi
    done < <(./dc config --services 2>/dev/null | grep -E '^php[0-9]+$' || true)
  else
    warn "Docker daemon is unavailable; skipping running-service checks"
  fi
else
  warn "Docker Compose v2 is unavailable; skipping Compose checks"
fi

say "Generated vhosts"
if compgen -G 'runtime/generated/nginx/vhosts/*.conf' >/dev/null; then
  for conf in runtime/generated/nginx/vhosts/*.conf; do
    printf '%s\n' "$conf"
    grep -E 'server_name |fastcgi_pass |proxy_pass |ssl_certificate |acme_certificate ' "$conf" | sed 's/^/  /' || true
  done
else
  warn "no runtime/generated/nginx/vhosts/*.conf files found; run ./manage.py render"
fi

say "Summary"
echo "Use README.md and .agents/skills/bento/references/deploy-runbook.md for deployment workflows."
