ARG NGINX_IMAGE=nginx:1.30-trixie
FROM ${NGINX_IMAGE} AS modules

ARG BROTLI_COMMIT=a71f9312c2deb28875acc7bacfdd5695a111aa53
ARG ZSTD_COMMIT=6be764e2bed04f889af824eff2d4dd737ebdab5a

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates cmake curl git libpcre2-dev libssl-dev libzstd-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN curl -fsSLO "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && tar -xzf "nginx-${NGINX_VERSION}.tar.gz" \
    && git clone --filter=blob:none https://github.com/google/ngx_brotli.git \
    && cd ngx_brotli \
    && git checkout "${BROTLI_COMMIT}" \
    && git submodule update --init --recursive --depth 1 \
    && cmake -S deps/brotli -B deps/brotli/out \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBROTLI_DISABLE_TESTS=ON \
    && cmake --build deps/brotli/out --config Release --parallel "$(nproc)" \
    && cd .. \
    && git clone --filter=blob:none https://github.com/tokers/zstd-nginx-module.git \
    && cd zstd-nginx-module \
    && git checkout "${ZSTD_COMMIT}"

WORKDIR /usr/src/nginx-${NGINX_VERSION}
RUN ./configure \
        --with-compat \
        --add-dynamic-module=/usr/src/ngx_brotli \
        --add-dynamic-module=/usr/src/zstd-nginx-module \
    && make -j"$(nproc)" modules

FROM ${NGINX_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends libzstd1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_brotli_filter_module.so /usr/lib/nginx/modules/
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_brotli_static_module.so /usr/lib/nginx/modules/
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_filter_module.so /usr/lib/nginx/modules/
COPY --from=modules /usr/src/nginx-${NGINX_VERSION}/objs/ngx_http_zstd_static_module.so /usr/lib/nginx/modules/
