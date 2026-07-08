FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      redis-server; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /data; \
    chown redis:redis /data

USER redis
WORKDIR /data

CMD ["redis-server"]
