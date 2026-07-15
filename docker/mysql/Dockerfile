ARG MYSQL_BASE_IMAGE=mysql:8.4
FROM ${MYSQL_BASE_IMAGE}

# Backup and restore compression runs beside the matching MySQL client tools.
# Support both Oracle Linux based current images and Debian based legacy tags.
USER root
RUN set -eux; \
    if command -v bash >/dev/null 2>&1 && command -v gzip >/dev/null 2>&1 && command -v zstd >/dev/null 2>&1; then \
        :; \
    elif command -v microdnf >/dev/null 2>&1; then \
        microdnf install -y bash gzip zstd; \
        microdnf clean all; \
    elif command -v dnf >/dev/null 2>&1; then \
        dnf install -y bash gzip zstd; \
        dnf clean all; \
    elif command -v yum >/dev/null 2>&1; then \
        yum install -y bash gzip zstd; \
        yum clean all; \
    elif command -v apt-get >/dev/null 2>&1; then \
        apt-get update; \
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash gzip zstd; \
        rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null 2>&1; then \
        apk add --no-cache bash gzip zstd; \
    else \
        echo >&2 "Unsupported MySQL base image: backup tools missing and no supported package manager found"; \
        exit 1; \
    fi; \
    command -v bash; \
    command -v gzip; \
    command -v zstd
