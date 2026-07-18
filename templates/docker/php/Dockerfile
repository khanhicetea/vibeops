# Bento PHP runtime: FPM + CLI + runner (s6-overlay/supercronic) from one image.
ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-bookworm

ARG PHP_VERSION
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.3.2
ENV BENTO_PHP_VERSION=${PHP_VERSION}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
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
    zstd \
    nodejs \
    npm \
  && rm -rf /var/lib/apt/lists/*

# Configure gd once, then install extensions one-by-one (avoids install races).
RUN docker-php-ext-configure gd --with-freetype --with-jpeg

RUN docker-php-ext-install bcmath
RUN docker-php-ext-install exif
RUN docker-php-ext-install gd
RUN docker-php-ext-install intl
RUN docker-php-ext-install pcntl
RUN docker-php-ext-install pdo_mysql
RUN docker-php-ext-install pdo_sqlite
RUN docker-php-ext-install soap
RUN docker-php-ext-install sockets
RUN docker-php-ext-install zip
RUN docker-php-ext-install mysqli

# OPcache is bundled with the official image; enable rather than rebuild when possible.
RUN (docker-php-ext-install opcache || docker-php-ext-enable opcache || true) \
  && pecl install redis \
  && docker-php-ext-enable redis

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# s6-overlay v3 provides PID 1, signal handling, and the s6 supervision tools.
# Keep the version explicit so builds are reproducible; update this ARG when a
# newer upstream release is adopted.
RUN set -eux; \
  case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
    amd64|x86_64) s6_arch=x86_64 ;; \
    arm64|aarch64) s6_arch=aarch64 ;; \
    *) echo "unsupported s6-overlay architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
  curl -fsSLo /tmp/s6-overlay-noarch.tar.xz "$base/s6-overlay-noarch.tar.xz"; \
  curl -fsSLo /tmp/s6-overlay-arch.tar.xz "$base/s6-overlay-${s6_arch}.tar.xz"; \
  tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz; \
  tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz; \
  rm -f /tmp/s6-overlay-*.tar.xz

# Supercronic for container-friendly cron
RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64|amd64) sc_arch=amd64 ;; \
    aarch64|arm64) sc_arch=arm64 ;; \
    *) sc_arch=amd64 ;; \
  esac; \
  curl -fsSLo /usr/local/bin/supercronic \
    "https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-${sc_arch}"; \
  chmod +x /usr/local/bin/supercronic

# Shared socket group used by Nginx and FPM (gid 1500)
RUN groupadd -g 1500 bento-web || true \
  && mkdir -p /run/php-fpm /etc/bento/cron /etc/bento/services /opt/bento/helpers /var/log/bento \
  && chown www-data:bento-web /run/php-fpm

COPY conf/php-bento.ini /usr/local/etc/php/conf.d/zz-bento.ini
COPY conf/opcache.ini /usr/local/etc/php/conf.d/zz-opcache.ini
COPY conf/www-docker.conf /usr/local/etc/php-fpm.d/zz-docker.conf
COPY entrypoint.sh /usr/local/bin/bento-php-entrypoint
COPY runner-entrypoint.sh /usr/local/bin/bento-runner-entrypoint
COPY s6-reconcile.sh /usr/local/bin/bento-s6-reconcile
RUN chmod +x /usr/local/bin/bento-php-entrypoint /usr/local/bin/bento-runner-entrypoint \
  /usr/local/bin/bento-s6-reconcile

COPY helpers/ /opt/bento/helpers/
RUN chmod +x /opt/bento/helpers/*.sh 2>/dev/null || true

WORKDIR /home
ENTRYPOINT ["bento-php-entrypoint"]
CMD ["php-fpm", "-F"]
