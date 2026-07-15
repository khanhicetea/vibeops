#!/bin/sh
set -eu

max_size=${NGINX_ACCESS_LOG_MAX_SIZE:-100M}
max_files=${NGINX_ACCESS_LOG_ROTATE:-14}

if ! printf '%s\n' "$max_size" | grep -Eqi '^[1-9][0-9]*([KMG](B)?)?$'; then
    echo "Invalid NGINX_ACCESS_LOG_MAX_SIZE: $max_size" >&2
    exit 1
fi
case "$max_files" in
    ''|*[!0-9]*)
        echo "Invalid NGINX_ACCESS_LOG_ROTATE: $max_files" >&2
        exit 1
        ;;
esac

sed \
    -e "s|@MAX_SIZE@|$max_size|g" \
    -e "s|@MAX_FILES@|$max_files|g" \
    /etc/bento/logrotate.conf.template \
    > /etc/logrotate.d/bento-nginx
chmod 0644 /etc/logrotate.d/bento-nginx
