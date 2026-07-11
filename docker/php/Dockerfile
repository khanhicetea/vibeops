ARG PHP_VERSION=8.4
FROM php:${PHP_VERSION}-fpm-trixie

ARG TZ=Asia/Ho_Chi_Minh
ARG SUPERCRONIC_VERSION=0.2.47
ARG NODE_VERSION=24.11.1
# Global PHP-FPM process cap across all pools in this container (safety bound).
ARG PHP_FPM_PROCESS_MAX=32
ENV TZ=${TZ}
ENV PHP_FPM_PROCESS_MAX=${PHP_FPM_PROCESS_MAX}

RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      grep \
      gzip \
      openssh-client \
      openssl \
      passwd \
      logrotate \
      tzdata \
      util-linux \
      unzip \
      vim \
      xz-utils \
      $PHPIZE_DEPS \
      libfreetype6 \
      libicu76 \
      libjpeg62-turbo \
      libpng16-16 \
      libzip5 \
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
    for f in /usr/local/etc/php-fpm.d/*.conf; do \
      [ -e "$f" ] || continue; \
      if grep -q '^\[www\]' "$f"; then rm -f "$f"; fi; \
    done; \
    case "${PHP_FPM_PROCESS_MAX}" in ''|*[!0-9]*|0*) echo "Invalid PHP_FPM_PROCESS_MAX: ${PHP_FPM_PROCESS_MAX}" >&2; exit 1 ;; esac; \
    printf '[global]\nerror_log = /proc/self/fd/2\nprocess.max = %s\ninclude=/usr/local/etc/php-fpm.d/pools/*.conf\n' "${PHP_FPM_PROCESS_MAX}" > /usr/local/etc/php-fpm.d/zz-vibeops.conf; \
    php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"; \
    php -r "if (hash_file('sha384', 'composer-setup.php') !== trim(file_get_contents('https://composer.github.io/installer.sig'))) { unlink('composer-setup.php'); exit(1); }"; \
    php composer-setup.php --install-dir=/usr/local/bin --filename=composer; \
    rm composer-setup.php; \
    deb_arch="$(dpkg --print-architecture)"; \
    case "$deb_arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture for Node.js: $deb_arch" >&2; exit 1 ;; \
    esac; \
    node_dist="node-v${NODE_VERSION}-linux-${node_arch}"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${node_dist}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${node_dist}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${node_dist}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${node_dist}.tar.xz" SHASUMS256.txt; \
    node --version; \
    npm --version; \
    apt-mark auto '.*' > /dev/null; \
    apt-mark manual $savedAptMark bash ca-certificates curl git gosu grep gzip openssh-client openssl passwd logrotate tzdata util-linux unzip vim xz-utils libfreetype6 libicu76 libjpeg62-turbo libpng16-16 libzip5; \
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
      amd64) supercronic_arch="amd64"; supercronic_sha1="712d2ece75da6f6e530192a151488578153e4e96" ;; \
      arm64) supercronic_arch="arm64"; supercronic_sha1="93323899ddca3f1198f1796a4bf4418ed1e7982e" ;; \
      *) echo "Unsupported architecture for supercronic: $deb_arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-${supercronic_arch}"; \
    echo "$supercronic_sha1  /usr/local/bin/supercronic" | sha1sum -c -; \
    chmod +x /usr/local/bin/supercronic

COPY bin/php-identity-sync /usr/local/bin/php-identity-sync
COPY bin/php-permissions /usr/local/bin/php-permissions
COPY bin/php-app-run /usr/local/bin/php-app-run
COPY bin/php-cron-as /usr/local/bin/php-cron-as
COPY bin/php-supercronic /usr/local/bin/php-supercronic
RUN chmod +x \
      /usr/local/bin/php-identity-sync \
      /usr/local/bin/php-permissions \
      /usr/local/bin/php-app-run \
      /usr/local/bin/php-cron-as \
      /usr/local/bin/php-supercronic

WORKDIR /home
CMD ["php-fpm"]
