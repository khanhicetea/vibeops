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

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libzstd1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_filter_module.so /usr/lib/nginx/modules/
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_static_module.so /usr/lib/nginx/modules/

RUN printf '%s\n' \
        'load_module modules/ngx_http_zstd_filter_module.so;' \
        'load_module modules/ngx_http_zstd_static_module.so;' \
        'events {}' \
        'http {}' \
        > /tmp/nginx-zstd-test.conf \
    && nginx -t -c /tmp/nginx-zstd-test.conf \
    && rm /tmp/nginx-zstd-test.conf
