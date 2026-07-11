#!/bin/sh
set -eu

case "${REDIS_APP_ACL:-false}" in
  true|false) ;;
  *) echo >&2 "REDIS_APP_ACL must be true or false"; exit 1 ;;
esac
for name in REDIS_ADMIN_PASSWORD REDIS_PASSWORD REDIS_LEGACY_PASSWORD; do
  eval "value=\${$name:-}"
  case "$value" in
    *[!A-Za-z0-9._~-]*) echo >&2 "$name may contain only A-Z, a-z, 0-9, '.', '_', '~', '-'"; exit 1 ;;
  esac
done

acl_file=/data/users.acl
if [ "${REDIS_APP_ACL:-false}" = true ]; then
  [ -n "${REDIS_ADMIN_PASSWORD:-}" ] || { echo >&2 "REDIS_ADMIN_PASSWORD is required when REDIS_APP_ACL=true"; exit 1; }
  if [ ! -s "$acl_file" ]; then
    umask 077
    {
      if [ -n "${REDIS_LEGACY_PASSWORD:-}" ]; then
        printf 'user default on >%s ~* &* +@all -@admin -@dangerous\n' "$REDIS_LEGACY_PASSWORD"
      else
        echo 'user default off'
      fi
      printf 'user admin on >%s ~* &* +@all\n' "$REDIS_ADMIN_PASSWORD"
    } > "$acl_file"
  fi
  set -- --aclfile "$acl_file"
else
  # Shared compatibility mode: password is optional to preserve existing installs.
  rm -f "$acl_file"
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    set -- --requirepass "$REDIS_PASSWORD"
  else
    set --
  fi
fi

exec redis-server \
  --appendonly yes \
  "$@" \
  --maxmemory "${REDIS_MAXMEMORY:-256mb}" \
  --maxmemory-policy "${REDIS_MAXMEMORY_POLICY:-allkeys-lru}"
