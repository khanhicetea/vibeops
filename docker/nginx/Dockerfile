ARG NGINX_BASE_IMAGE=nginx:1.30-trixie

FROM ${NGINX_BASE_IMAGE} AS modules

ARG ZSTD_MODULE_COMMIT=74ea74df8b382e9bc819a41392336bd6dee036c4

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        libpcre2-dev \
        libssl-dev \
        libzstd-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN curl --fail --silent --show-error --location --remote-name \
        "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && tar -xzf "nginx-${NGINX_VERSION}.tar.gz" \
    && git clone --filter=blob:none https://github.com/myguard-labs/nginx-zstd-module.git \
    && git -C nginx-zstd-module checkout --detach "${ZSTD_MODULE_COMMIT}" \
    && test "$(git -C nginx-zstd-module rev-parse HEAD)" = "${ZSTD_MODULE_COMMIT}"

WORKDIR /usr/src/nginx-${NGINX_VERSION}
RUN ./configure \
        --with-compat \
        --with-cc-opt="-O2 -DZSTD_STATIC_LINKING_ONLY" \
        --add-dynamic-module=/usr/src/nginx-zstd-module \
    && make -j"$(nproc)" modules

FROM ${NGINX_BASE_IMAGE}

ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.3.1
ARG SUPERCRONIC_VERSION=0.2.47

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        goaccess \
        gzip \
        libzstd1 \
        logrotate \
        util-linux \
        xz-utils \
    && case "$TARGETARCH" in \
        amd64) s6_arch=x86_64; s6_sha256=ed72fdb3abf196472d121b026bed63b46f3443507bd2ce67df6bd187f7d4dc0a; supercronic_arch=amd64; supercronic_sha1=712d2ece75da6f6e530192a151488578153e4e96 ;; \
        arm64) s6_arch=aarch64; s6_sha256=c79b5cc7e5e405f6e1ae1466a8160ac84d29b86614e1e01ff0fb11dc832fee1b; supercronic_arch=arm64; supercronic_sha1=93323899ddca3f1198f1796a4bf4418ed1e7982e ;; \
        *) echo "Unsupported nginx maintenance architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/s6-overlay-noarch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    && echo "43d99d266fefe32cdc1510963aaadeb211cc8450b60af27817b64af450c934be  /tmp/s6-overlay-noarch.tar.xz" | sha256sum -c - \
    && curl -fsSL -o /tmp/s6-overlay-arch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz" \
    && echo "$s6_sha256  /tmp/s6-overlay-arch.tar.xz" | sha256sum -c - \
    && tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz \
    && curl -fsSL -o /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-${supercronic_arch}" \
    && echo "$supercronic_sha1  /usr/local/bin/supercronic" | sha1sum -c - \
    && chmod 0755 /usr/local/bin/supercronic \
    && rm -rf /var/lib/apt/lists/* /tmp/s6-overlay-*.tar.xz

COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_filter_module.so /usr/lib/nginx/modules/
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_static_module.so /usr/lib/nginx/modules/
COPY bin/bento-nginx-maintenance /usr/local/bin/bento-nginx-maintenance
COPY nginx-maintenance.cron /etc/bento/nginx-maintenance.cron
COPY cont-init.d/ /etc/cont-init.d/
COPY services.d/ /etc/services.d/

RUN chmod 0755 \
        /usr/local/bin/bento-nginx-maintenance \
        /etc/cont-init.d/10-bento-maintenance-init \
        /etc/services.d/supercronic/run \
    && /usr/local/bin/supercronic -no-reap -test /etc/bento/nginx-maintenance.cron

RUN printf '%s\n' \
        'load_module modules/ngx_http_zstd_filter_module.so;' \
        'load_module modules/ngx_http_zstd_static_module.so;' \
        'events {}' \
        'http {}' \
        > /tmp/nginx-zstd-test.conf \
    && nginx -t -c /tmp/nginx-zstd-test.conf \
    && rm /tmp/nginx-zstd-test.conf

# s6 supervises maintenance only. Nginx remains the main CMD: when it exits,
# s6-overlay shuts down the container and propagates its exit status.
ENTRYPOINT ["/init"]
CMD ["/docker-entrypoint.sh", "nginx", "-g", "daemon off;"]
