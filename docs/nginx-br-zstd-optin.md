# Opt in to Brotli and Zstandard compression

VibeOps uses the official Nginx image and gzip by default. This guide builds a local image with the third-party Brotli and Zstandard dynamic modules. It supports both precompressed static files (`.br`, `.zst`) and on-the-fly compression for static, FastCGI, and proxied responses.

This is a local customization: keep it in `runtime/custom/` and `compose.override.yml` so upstream `compose.yml` remains unchanged. Rebuild the image whenever the configured Nginx version changes.

## 1. Create the custom Dockerfile

```bash
mkdir -p runtime/custom/nginx/br-zstd
```

Create `runtime/custom/nginx/br-zstd/Dockerfile`:

```dockerfile
ARG NGINX_IMAGE=nginx:1.30-trixie
FROM ${NGINX_IMAGE} AS modules

# Pin module sources for reproducible builds. Review and update these commits deliberately.
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
```

The explicit CMake step is required: without it, linking fails because `libbrotlienc` and `libbrotlicommon` have not been built.

## 2. Create local Nginx configuration

Copy the upstream files so this customization starts from the version currently deployed:

```bash
cp config/nginx/nginx.conf runtime/custom/nginx/br-zstd/nginx.conf
cp config/nginx/global/00-nginx.conf runtime/custom/nginx/br-zstd/00-nginx.conf
```

In `runtime/custom/nginx/br-zstd/nginx.conf`, add these lines immediately after the ACME `load_module` line. Load Zstd after Brotli; dynamic filters prepend themselves to the filter chain, giving the desired `zstd > br > gzip` preference.

```nginx
load_module modules/ngx_http_brotli_filter_module.so;
load_module modules/ngx_http_brotli_static_module.so;
load_module modules/ngx_http_zstd_filter_module.so;
load_module modules/ngx_http_zstd_static_module.so;
```

In `runtime/custom/nginx/br-zstd/00-nginx.conf`, insert this block immediately before the existing `gzip on;` block:

```nginx
# Precompressed .zst/.br files and on-the-fly response compression.
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

Optionally replace the existing `gzip_types` line with the same MIME-type set used above. Keep `gzip_vary on;`; the Zstd static module uses it to emit `Vary: Accept-Encoding`.

## 3. Override the Nginx service locally

Create or extend the ignored `compose.override.yml`:

```yaml
services:
  nginx:
    image: vibeops-nginx-br-zstd:${NGINX_VERSION:-1.30}
    build:
      context: .
      dockerfile: runtime/custom/nginx/br-zstd/Dockerfile
      args:
        NGINX_IMAGE: nginx:${NGINX_VERSION:-1.30}-trixie
    volumes:
      - ./runtime/custom/nginx/br-zstd/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./runtime/custom/nginx/br-zstd/00-nginx.conf:/etc/nginx/global/00-nginx.conf:ro
```

Check the merged Compose model before deployment. The normal `/home`, vhost, socket, certificate, ACME, and log mounts must still be present:

```bash
./manage.py compose config
```

## 4. Build, validate, and deploy

```bash
./manage.py compose build nginx
./manage.py compose up -d nginx
./manage.py compose exec -T nginx nginx -t
```

If Nginx was already running, `up -d` recreates it with the custom image.

## 5. Verify negotiation and fallback

Use a response larger than `1000` bytes and a compressible MIME type. `HEAD` responses can differ from `GET`, so discard the body from a real `GET`:

```bash
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: zstd, br, gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: br, gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: identity' http://127.0.0.1/
```

Expected `Content-Encoding` values are `zstd`, `br`, `gzip`, and no header respectively. Compressed responses should also contain:

```text
Vary: Accept-Encoding
```

For readable response bodies, let curl negotiate and decompress automatically:

```bash
curl --compressed -H 'Host: example.com' http://127.0.0.1/
```

## Static precompression

With `zstd_static on`, `brotli_static on`, and `gzip_static on`, Nginx looks beside an original asset for matching files:

```text
app.js
app.js.zst
app.js.br
app.js.gz
```

Keep the original file. Generate compressed siblings during asset deployment, not inside the read-only Nginx container.

## Updating and disabling the customization

When changing `NGINX_VERSION`, rebuild without cache so modules are compiled against the exact Nginx version in the final image:

```bash
./manage.py compose build --no-cache nginx
./manage.py compose up -d nginx
```

Dynamic Nginx modules are ABI-sensitive; never copy modules compiled for another Nginx build.

To return to stock gzip-only Nginx, remove the `nginx` override from `compose.override.yml`, then recreate the service:

```bash
./manage.py compose up -d --force-recreate nginx
./manage.py compose exec -T nginx nginx -t
```
