FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

COPY docker-entrypoint.sh /usr/local/bin/vibeops-redis-entrypoint

RUN set -eux; \
    chmod 755 /usr/local/bin/vibeops-redis-entrypoint; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      redis-server; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /data; \
    chown redis:redis /data

USER redis
WORKDIR /data

ENTRYPOINT ["vibeops-redis-entrypoint"]
