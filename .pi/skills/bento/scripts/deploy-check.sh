#!/usr/bin/env bash
set -euo pipefail

find_stack_root() {
  local dir
  dir="$(pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/compose.yml" && -d "$dir/scripts" && -d "$dir/nginx" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done

  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/compose.yml" && -d "$dir/scripts" && -d "$dir/nginx" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done

  return 1
}

say() { printf '\n== %s ==\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
ok() { printf 'OK: %s\n' "$*"; }

ROOT="$(find_stack_root || true)"
if [[ -z "${ROOT:-}" ]]; then
  echo "Could not find bento root (compose.yml + scripts/ + nginx/)." >&2
  exit 1
fi
cd "$ROOT"

say "Stack root"
printf '%s\n' "$ROOT"

say "Required files"
for path in compose.yml README.md scripts/create-user.sh scripts/create-site.sh scripts/create-proxy.sh scripts/acme.sh nginx/nginx.conf nginx/conf.d/00-nginx.conf; do
  if [[ -e "$path" ]]; then ok "$path"; else warn "missing $path"; fi
done

say "Environment"
if [[ -f .env ]]; then
  ok ".env exists"
  if grep -q '^MYSQL_ROOT_PASSWORD=change-me-long-random-password$' .env; then
    warn "MYSQL_ROOT_PASSWORD is still the .env.example placeholder"
  elif grep -q '^MYSQL_ROOT_PASSWORD=' .env; then
    ok "MYSQL_ROOT_PASSWORD is set"
  else
    warn "MYSQL_ROOT_PASSWORD is missing from .env"
  fi
  grep -E '^(TZ|DEFAULT_PHP_VERSION|PHP84_VERSION|PHP85_VERSION|SOCKET_GID|FIX_HOME_OWNERSHIP)=' .env || true
else
  warn ".env missing; copy .env.example to .env and edit MYSQL_ROOT_PASSWORD"
fi

say "Host port listeners"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp '( sport = :80 or sport = :443 )' || true
  ss -lunp '( sport = :443 )' || true
else
  warn "ss not available; skipping port listener check"
fi

say "Docker Compose config"
if command -v docker >/dev/null 2>&1; then
  if docker compose config >/tmp/bento.compose.check.yml 2>/tmp/bento.compose.check.err; then
    ok "docker compose config is valid"
  else
    warn "docker compose config failed:"
    cat /tmp/bento.compose.check.err >&2
  fi

  say "Docker Compose services"
  docker compose ps || true

  running_services="$(docker compose ps --services --filter status=running 2>/dev/null || true)"

  if grep -qx nginx <<<"$running_services"; then
    say "Nginx validation"
    docker compose exec -T nginx nginx -t || warn "nginx -t failed"
  else
    warn "nginx is not running"
  fi

  for svc in php84 php85; do
    if grep -qx "$svc" <<<"$running_services"; then
      say "$svc validation"
      docker compose exec -T "$svc" php-fpm -tt || warn "$svc php-fpm -tt failed"
      printf 'Sockets in run/php-fpm/%s:\n' "$svc"
      ls -la "run/php-fpm/$svc" 2>/dev/null || true
    fi
  done
else
  warn "docker not available; skipping Compose checks"
fi

say "Generated vhosts"
if compgen -G 'nginx/conf.d/*.conf' >/dev/null; then
  for conf in nginx/conf.d/*.conf; do
    printf '%s\n' "$conf"
    grep -E 'server_name |fastcgi_pass |proxy_pass |ssl_certificate |acme_certificate ' "$conf" | sed 's/^/  /' || true
  done
else
  warn "no nginx/conf.d/*.conf files found"
fi

say "Summary"
echo "Use README.md and .pi/skills/bento/references/deploy-runbook.md for exact deployment workflows."
