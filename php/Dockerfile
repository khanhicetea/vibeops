ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-trixie

ARG TZ=Asia/Ho_Chi_Minh
ARG S6_OVERLAY_VERSION=3.2.0.2
ARG SUPERCRONIC_VERSION=0.2.33
ENV TZ=${TZ}
ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2

RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      openssh-client \
      openssl \
      passwd \
      tzdata \
      unzip \
      xz-utils \
      $PHPIZE_DEPS \
      libfreetype6-dev \
      libicu-dev \
      libjpeg62-turbo-dev \
      libonig-dev \
      libpng-dev \
      libzip-dev; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    php_exts="bcmath exif gd intl mbstring mysqli pcntl pdo_mysql zip"; \
    : "Build OPcache only when php -m shows it is absent (PHP 8.5 images may already include it)"; \
    if ! php -m | grep -qi '^Zend OPcache$'; then php_exts="$php_exts opcache"; fi; \
    docker-php-ext-install -j"$(nproc)" $php_exts; \
    pecl install redis; \
    docker-php-ext-enable redis; \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime; \
    echo ${TZ} > /etc/timezone; \
    mkdir -p /run/php-fpm /usr/local/etc/php/users.d /usr/local/etc/php-fpm.d/pools /var/log/php; \
    rm -f /usr/local/etc/php-fpm.d/www.conf; \
    printf 'include=/usr/local/etc/php-fpm.d/pools/*.conf\n' > /usr/local/etc/php-fpm.d/zz-pools.conf; \
    php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"; \
    php -r "if (hash_file('sha384', 'composer-setup.php') !== trim(file_get_contents('https://composer.github.io/installer.sig'))) { unlink('composer-setup.php'); exit(1); }"; \
    php composer-setup.php --install-dir=/usr/local/bin --filename=composer; \
    rm composer-setup.php; \
    apt-mark auto '.*' > /dev/null; \
    apt-mark manual $savedAptMark bash ca-certificates curl git gosu openssh-client openssl passwd tzdata unzip xz-utils; \
    ldd "$(php -r 'echo ini_get("extension_dir");')"/*.so \
      | awk '/=>/ { print $3 } /^\// { print $1 }' \
      | xargs -r -I '{}' sh -c 'dpkg-query -S "$1" 2>/dev/null | cut -d: -f1' sh '{}' \
      | sort -u \
      | xargs -r apt-mark manual; \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/* /tmp/pear ~/.pearrc

RUN set -eux; \
    deb_arch="$(dpkg --print-architecture)"; \
    case "$deb_arch" in \
      amd64) s6_arch="x86_64"; supercronic_arch="amd64" ;; \
      arm64) s6_arch="aarch64"; supercronic_arch="arm64" ;; \
      *) echo "Unsupported architecture for s6/supercronic: $deb_arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
      | tar -C / -Jxpf -; \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz" \
      | tar -C / -Jxpf -; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-${supercronic_arch}"; \
    chmod +x /usr/local/bin/supercronic

COPY php-user-sync /usr/local/bin/php-user-sync
COPY php-cron-as /usr/local/bin/php-cron-as
COPY s6/ /etc/
RUN chmod +x \
      /usr/local/bin/php-user-sync \
      /usr/local/bin/php-cron-as \
      /etc/cont-init.d/10-php-user-sync \
      /etc/services.d/php-fpm/run \
      /etc/services.d/cron/run

WORKDIR /home
ENTRYPOINT ["/init"]
CMD []
