#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s nullglob

log() {
    printf '%s [MySQL entrypoint] %s\n' "$(date --iso-8601=seconds)" "$*"
}

fatal() {
    log "ERROR: $*" >&2
    exit 1
}

file_env() {
    local name="$1"
    local file_name="${name}_FILE"
    local value="${!name:-}"
    local file_value="${!file_name:-}"

    if [[ -n "$value" && -n "$file_value" ]]; then
        fatal "$name and $file_name are mutually exclusive"
    fi
    if [[ -n "$file_value" ]]; then
        [[ -r "$file_value" ]] || fatal "$file_name is not readable"
        value="$(<"$file_value")"
    fi
    export "$name=$value"
    unset "$file_name"
}

mysql_config_value() {
    local key="$1"
    shift
    "$@" --verbose --help --log-bin-index="/tmp/mysql-help-$$.index" 2>/dev/null \
        | awk -v key="$key" '$1 == key && /^[^[:space:]]/ { sub(/^[^[:space:]]+[[:space:]]+/, ""); print; exit }'
}

escape_sql_string() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\'/\'\'}"
    printf '%s' "$value"
}

write_client_config() {
    local path="$1"
    local password="$2"
    local socket="$3"
    local escaped="$password"
    escaped="${escaped//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    umask 077
    printf '[client]\nuser="root"\npassword="%s"\nprotocol="socket"\nsocket="%s"\n' \
        "$escaped" "$socket" > "$path"
}

process_init_files() {
    local client_config="$1"
    local file
    for file in /docker-entrypoint-initdb.d/*; do
        case "$file" in
            *.sh)
                log "Running $file"
                if [[ -x "$file" ]]; then "$file"; else source "$file"; fi
                ;;
            *.sql)
                log "Running $file"
                mysql --defaults-extra-file="$client_config" < "$file"
                ;;
            *.sql.gz)
                log "Running $file"
                gzip -dc "$file" | mysql --defaults-extra-file="$client_config"
                ;;
            *) log "Ignoring $file" ;;
        esac
    done
}

initialize_database() {
    local datadir="$1"
    local socket="$2"
    shift 2
    local -a server=("$@")
    local temp_dir client_config password_sql i

    file_env MYSQL_ROOT_PASSWORD
    [[ -n "${MYSQL_ROOT_PASSWORD:-}" ]] || fatal "MYSQL_ROOT_PASSWORD must be set for a new database"
    [[ "$MYSQL_ROOT_PASSWORD" != *$'\n'* && "$MYSQL_ROOT_PASSWORD" != *$'\r'* ]] \
        || fatal "MYSQL_ROOT_PASSWORD must not contain newlines"

    log "Initializing database files"
    gosu mysql "${server[@]}" --initialize-insecure --datadir="$datadir"

    log "Starting temporary server"
    gosu mysql "${server[@]}" \
        --daemonize \
        --skip-networking \
        --socket="$socket" \
        --pid-file=/var/run/mysqld/init.pid

    for ((i = 60; i > 0; i--)); do
        if mysqladmin --protocol=socket --socket="$socket" --user=root ping --silent >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    (( i > 0 )) || fatal "Temporary server did not become ready"

    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT
    client_config="$temp_dir/client.cnf"
    write_client_config "$client_config" "$MYSQL_ROOT_PASSWORD" "$socket"
    password_sql="$(escape_sql_string "$MYSQL_ROOT_PASSWORD")"

    mysql --protocol=socket --socket="$socket" --user=root <<-SQL
        ALTER USER 'root'@'localhost' IDENTIFIED BY '${password_sql}';
        DELETE FROM mysql.user WHERE User = '';
        DROP DATABASE IF EXISTS test;
        FLUSH PRIVILEGES;
SQL

    process_init_files "$client_config"
    mysqladmin --defaults-extra-file="$client_config" shutdown
    rm -rf "$temp_dir"
    trap - EXIT
    log "Database initialization complete"
}

main() {
    if [[ "${1:-}" == -* ]]; then
        set -- mysqld "$@"
    fi
    if [[ "${1:-}" != "mysqld" ]]; then
        exec "$@"
    fi

    local datadir socket
    datadir="$(mysql_config_value datadir "$@")"
    socket="$(mysql_config_value socket "$@")"
    [[ -n "$datadir" ]] || fatal "Unable to determine MySQL data directory"
    [[ -n "$socket" ]] || fatal "Unable to determine MySQL socket path"

    mkdir -p "$datadir" "$(dirname "$socket")" /var/log/mysql /var/run/mysqld
    if [[ "$(id -u)" == 0 ]]; then
        find "$datadir" "$(dirname "$socket")" /var/log/mysql /var/run/mysqld \
            \! -user mysql -exec chown mysql:mysql '{}' +
    fi

    if [[ ! -d "$datadir/mysql" ]]; then
        [[ "$(id -u)" == 0 ]] || fatal "Database initialization requires the container to start as root"
        initialize_database "$datadir" "$socket" "$@"
    fi

    unset MYSQL_ROOT_PASSWORD MYSQL_ROOT_PASSWORD_FILE
    log "Starting MySQL ${MYSQL_VERSION}"
    if [[ "$(id -u)" == 0 ]]; then
        exec gosu mysql "$@"
    fi
    exec "$@"
}

main "$@"
