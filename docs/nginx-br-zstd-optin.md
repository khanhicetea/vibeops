# Optional Brotli and Zstandard Nginx image

The stock stack uses the official `nginx:1.30-trixie` image and gzip. This local customization builds ABI-compatible Brotli and Zstandard dynamic modules without changing `config/compose.yml`.

Dynamic modules must be rebuilt whenever the Nginx image changes.

## Build context

```bash
mkdir -p runtime/custom/nginx/br-zstd
```

Create `runtime/custom/nginx/br-zstd/Dockerfile`:

```dockerfile
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
       -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBROTLI_DISABLE_TESTS=ON \
    && cmake --build deps/brotli/out --config Release --parallel "$(nproc)" \
    && cd .. \
    && git clone --filter=blob:none https://github.com/tokers/zstd-nginx-module.git \
    && cd zstd-nginx-module \
    && git checkout "${ZSTD_COMMIT}"

WORKDIR /usr/src/nginx-${NGINX_VERSION}
RUN ./configure --with-compat \
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
```

Pinned source commits make builds reviewable. Update them deliberately.

## Local configuration

Copy the currently deployed tracked config:

```bash
cp config/nginx/nginx.conf runtime/custom/nginx/br-zstd/nginx.conf
cp config/nginx/global/00-nginx.conf runtime/custom/nginx/br-zstd/00-nginx.conf
```

In the copied `nginx.conf`, add these after the ACME module load. Keep Zstd after Brotli so the dynamic filter order prefers `zstd`, then `br`, then gzip:

```nginx
load_module modules/ngx_http_brotli_filter_module.so;
load_module modules/ngx_http_brotli_static_module.so;
load_module modules/ngx_http_zstd_filter_module.so;
load_module modules/ngx_http_zstd_static_module.so;
```

In the copied `00-nginx.conf`, add this before the existing gzip block:

```nginx
zstd on;
zstd_static on;
zstd_min_length 1000;
zstd_comp_level 3;
zstd_buffers 16 8k;
zstd_types text/plain text/css application/json application/ld+json application/javascript application/xml application/xml+rss image/svg+xml font/ttf font/otf application/vnd.ms-fontobject;

brotli on;
brotli_static on;
brotli_min_length 1000;
brotli_comp_level 4;
brotli_buffers 16 8k;
brotli_types text/plain text/css application/json application/ld+json application/javascript application/xml application/xml+rss image/svg+xml font/ttf font/otf application/vnd.ms-fontobject;
```

Keep `gzip_vary on`; the static compression modules rely on correct `Vary: Accept-Encoding` behavior.

## Compose override

Create or extend `compose.override.yml`:

```yaml
services:
  nginx:
    image: bento-nginx-br-zstd:${NGINX_VERSION:-1.30}
    build:
      context: .
      dockerfile: runtime/custom/nginx/br-zstd/Dockerfile
      args:
        NGINX_IMAGE: nginx:${NGINX_VERSION:-1.30}-trixie
    volumes:
      - ./runtime/custom/nginx/br-zstd/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./runtime/custom/nginx/br-zstd/00-nginx.conf:/etc/nginx/global/00-nginx.conf:ro
```

Compose volume-list merging can be surprising. Confirm that the merged service still contains bento's `/home`, vhost, socket, cert, ACME-state, and log mounts:

```bash
./dc config
```

## Build and verify

```bash
./dc build nginx
./dc up -d nginx
./dc exec -T nginx nginx -t
```

Test a compressible response larger than 1000 bytes with a real GET:

```bash
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: zstd, br, gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: br, gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: identity' http://127.0.0.1/
```

Expected encodings are `zstd`, `br`, `gzip`, and none. Compressed responses should include `Vary: Accept-Encoding`.

For static precompression, deploy siblings beside the original asset:

```text
app.js
app.js.zst
app.js.br
app.js.gz
```

Nginx mounts `/home` read-only, so generate these during application deployment.

## Upgrade or disable

After changing Nginx version, rebuild modules against the exact final image:

```bash
./dc build --no-cache nginx
./dc up -d nginx
./dc exec -T nginx nginx -t
```

To return to stock gzip, remove the Nginx override and recreate the service:

```bash
./dc up -d --force-recreate nginx
./dc exec -T nginx nginx -t
```
