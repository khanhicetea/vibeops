# Bento Nginx ingress image: host-network ready, HTTP/2+3 capable base.
# Zstd modules are optional; gzip remains the compatibility fallback.
ARG NGINX_VERSION=1.27.4
FROM nginx:${NGINX_VERSION}-bookworm

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssl \
    libzstd1 \
  && rm -rf /var/lib/apt/lists/*

# Runtime layout expected by generated mounts
RUN mkdir -p /etc/nginx/sites /etc/nginx/snippets /etc/nginx/certs /var/log/nginx /run/php-fpm \
  && rm -f /etc/nginx/conf.d/default.conf

COPY snippets/ /etc/nginx/snippets/
COPY docker-entrypoint.d/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.sh || true

# Default boot certs are generated at container start if missing (mounted volume preferred).
EXPOSE 80 443/tcp 443/udp
