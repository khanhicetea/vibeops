FROM debian:bullseye-slim@sha256:256e2eb1c47e91d91d1332b436b2efac5cd2511dc82fb78850fd01770cce2162 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV MYSQL_VERSION=5.7.44
ENV MYSQL_SOURCE_SHA256=b8fe262c4679cb7bbc379a3f1addc723844db168628ce2acf78d33906849e491

# The slim base has no CA bundle yet. APT authenticates these HTTP snapshot
# downloads through Debian's signed InRelease metadata and package hashes.
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
        'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250201T000000Z bullseye main' \
        'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20250201T000000Z bullseye-security main' \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
        bison \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        libaio-dev \
        libc-dev-bin \
        libncurses5-dev \
        libnuma-dev \
        libssl-dev \
        libtirpc-dev \
        pkg-config \
        xz-utils \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/mysql
RUN curl --fail --location --proto '=https' --tlsv1.2 --retry 5 \
        --output mysql.tar.gz \
        "https://cdn.mysql.com/Downloads/MySQL-5.7/mysql-boost-${MYSQL_VERSION}.tar.gz" \
    && echo "${MYSQL_SOURCE_SHA256}  mysql.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --strip-components=1 --file=mysql.tar.gz \
    && rm mysql.tar.gz

RUN cmake -S . -B build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local/mysql \
        -DMYSQL_DATADIR=/var/lib/mysql \
        -DMYSQL_MAINTAINER_MODE=OFF \
        -DSYSCONFDIR=/etc/mysql \
        -DWITH_BOOST=boost \
        -DWITH_EDITLINE=bundled \
        -DWITH_SSL=system \
        -DWITH_ZLIB=system \
        -DENABLED_LOCAL_INFILE=ON \
        -DWITH_UNIT_TESTS=OFF \
    && cmake --build build --parallel "$(nproc)" \
    && cmake --install build \
    && rm -rf /usr/local/mysql/mysql-test /usr/local/mysql/sql-bench

FROM debian:bullseye-slim@sha256:256e2eb1c47e91d91d1332b436b2efac5cd2511dc82fb78850fd01770cce2162

ENV DEBIAN_FRONTEND=noninteractive
ENV MYSQL_MAJOR=5.7
ENV MYSQL_VERSION=5.7.44
ENV PATH=/usr/local/mysql/bin:$PATH

# The slim base has no CA bundle yet. APT authenticates these HTTP snapshot
# downloads through Debian's signed InRelease metadata and package hashes.
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
        'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250201T000000Z bullseye main' \
        'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20250201T000000Z bullseye-security main' \
        > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        gosu \
        gzip \
        libaio1 \
        libatomic1 \
        libncurses5 \
        libnuma1 \
        libssl1.1 \
        libstdc++6 \
        libtinfo5 \
        tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 999 mysql \
    && useradd --system --uid 999 --gid mysql --home-dir /nonexistent --shell /usr/sbin/nologin mysql \
    && mkdir -p /docker-entrypoint-initdb.d /etc/mysql/conf.d /var/lib/mysql /var/run/mysqld \
    && chown mysql:mysql /var/lib/mysql /var/run/mysqld

COPY --from=builder /usr/local/mysql /usr/local/mysql
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && mysqld --version \
    && ldd /usr/local/mysql/bin/mysqld > /tmp/mysqld-ldd \
    && ! grep -F 'not found' /tmp/mysqld-ldd \
    && find /usr/local/mysql/lib/plugin -type f -name '*.so' -exec ldd '{}' \; > /tmp/plugin-ldd \
    && ! grep -F 'not found' /tmp/plugin-ldd \
    && rm /tmp/mysqld-ldd /tmp/plugin-ldd \
    && gosu mysql true

VOLUME ["/var/lib/mysql"]
EXPOSE 3306
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["mysqld"]
