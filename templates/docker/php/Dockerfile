# syntax=docker/dockerfile:1.7
# Bento PHP runtime: FPM + CLI + runner (s6-overlay/supercronic) from one image.
ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-bookworm

ARG PHP_VERSION
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.3.2
ENV BENTO_PHP_VERSION=${PHP_VERSION}

USER root

# Build dependencies and all PHP extensions are installed together so they form
# one cacheable image layer.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    less \
    libcurl4-openssl-dev \
    libfreetype6-dev \
    libicu-dev \
    libjpeg62-turbo-dev \
    libonig-dev \
    libpng-dev \
    libsqlite3-dev \
    libssl-dev \
    libxml2-dev \
    libzip-dev \
    openssh-client \
    procps \
    logrotate \
    unzip \
    xz-utils \
    zip \
    zstd; \
  docker-php-ext-configure gd --with-freetype --with-jpeg; \
  docker-php-ext-install bcmath exif gd intl pcntl pdo_mysql pdo_sqlite soap sockets zip mysqli; \
  (docker-php-ext-install opcache || docker-php-ext-enable opcache || true); \
  pecl install redis; \
  docker-php-ext-enable redis; \
  rm -rf /var/lib/apt/lists/*

# s6-overlay v3 provides PID 1, signal handling, and the s6 supervision tools.
# Node.js LTS, Composer, and Supercronic are installed with it in one layer.
RUN set -eux; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64|x86_64) s6_arch=x86_64; sc_arch=amd64 ;; \
    arm64|aarch64) s6_arch=aarch64; sc_arch=arm64 ;; \
    *) echo "unsupported architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
  curl -fsSLo /tmp/s6-overlay-noarch.tar.xz "$base/s6-overlay-noarch.tar.xz"; \
  curl -fsSLo /tmp/s6-overlay-arch.tar.xz "$base/s6-overlay-${s6_arch}.tar.xz"; \
  tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz; \
  rm -f /tmp/s6-overlay-*.tar.xz; \
  curl -fsSLo /usr/local/bin/supercronic \
    "https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-${sc_arch}"; \
  chmod +x /usr/local/bin/supercronic; \
  curl -fsSL https://deb.nodesource.com/setup_lts.x -o /tmp/nodesource-setup.sh; \
  bash /tmp/nodesource-setup.sh; \
  apt-get install -y --no-install-recommends nodejs; \
  curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php; \
  php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer; \
  rm -f /tmp/nodesource-setup.sh /tmp/composer-setup.php; \
  rm -rf /var/lib/apt/lists/*

# The bind mount is available only during the build. Copying from it while
# creating the runtime user/group, directories, and permissions keeps all of
# this image initialization in one layer.
RUN --mount=type=bind,source=.,target=/tmp/bento-build,ro \
  set -eux; \
  getent group bento-web >/dev/null || groupadd -g 1500 bento-web; \
  install -d -m 0755 -o www-data -g bento-web /run/php-fpm; \
  install -d -m 0755 /etc/bento/cron /etc/bento/services /opt/bento/helpers /var/log/bento; \
  install -D -m 0644 /tmp/bento-build/conf/php-bento.ini /usr/local/etc/php/conf.d/zz-bento.ini; \
  install -D -m 0644 /tmp/bento-build/conf/opcache.ini /usr/local/etc/php/conf.d/zz-opcache.ini; \
  install -D -m 0644 /tmp/bento-build/conf/www-docker.conf /usr/local/etc/php-fpm.d/zz-docker.conf; \
  install -D -m 0755 /tmp/bento-build/entrypoint.sh /usr/local/bin/bento-php-entrypoint; \
  install -D -m 0755 /tmp/bento-build/runner-entrypoint.sh /usr/local/bin/bento-runner-entrypoint; \
  install -D -m 0755 /tmp/bento-build/s6-reconcile.sh /usr/local/bin/bento-s6-reconcile; \
  cp -a /tmp/bento-build/helpers/. /opt/bento/helpers/; \
  find /opt/bento/helpers -type f -name '*.sh' -exec chmod 0755 {} +

WORKDIR /home
ENTRYPOINT ["bento-php-entrypoint"]
CMD ["php-fpm", "-F"]
