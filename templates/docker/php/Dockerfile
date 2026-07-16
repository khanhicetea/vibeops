# Bento PHP runtime: FPM + CLI + runner (supervisord/supercronic) from one image.
ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-bookworm

ARG PHP_VERSION
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
    supervisor \
    unzip \
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
  && mkdir -p /run/php-fpm /etc/bento/cron /opt/bento/helpers /var/log/supervisor \
  && chown www-data:bento-web /run/php-fpm

COPY conf/php-bento.ini /usr/local/etc/php/conf.d/zz-bento.ini
COPY conf/opcache.ini /usr/local/etc/php/conf.d/zz-opcache.ini
COPY conf/www-docker.conf /usr/local/etc/php-fpm.d/zz-docker.conf
COPY entrypoint.sh /usr/local/bin/bento-php-entrypoint
COPY runner-entrypoint.sh /usr/local/bin/bento-runner-entrypoint
RUN chmod +x /usr/local/bin/bento-php-entrypoint /usr/local/bin/bento-runner-entrypoint

COPY helpers/ /opt/bento/helpers/
RUN chmod +x /opt/bento/helpers/*.sh 2>/dev/null || true

WORKDIR /home
ENTRYPOINT ["bento-php-entrypoint"]
CMD ["php-fpm", "-F"]
