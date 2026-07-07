ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-trixie

ARG TZ=Asia/Ho_Chi_Minh
ENV TZ=${TZ}

RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      openssl \
      passwd \
      tzdata \
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
    apt-mark manual $savedAptMark bash ca-certificates curl git openssl passwd tzdata; \
    ldd "$(php -r 'echo ini_get("extension_dir");')"/*.so \
      | awk '/=>/ { print $3 } /^\// { print $1 }' \
      | xargs -r -I '{}' sh -c 'dpkg-query -S "$1" 2>/dev/null | cut -d: -f1' sh '{}' \
      | sort -u \
      | xargs -r apt-mark manual; \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/* /tmp/pear ~/.pearrc

COPY php-user-sync /usr/local/bin/php-user-sync
COPY docker-entrypoint.sh /usr/local/bin/docker-stack-entrypoint
RUN chmod +x /usr/local/bin/php-user-sync /usr/local/bin/docker-stack-entrypoint

WORKDIR /home
ENTRYPOINT ["docker-stack-entrypoint"]
CMD ["php-fpm", "-F"]
