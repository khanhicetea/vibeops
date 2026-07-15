# Nginx Zstandard compression

Bento's default Nginx image builds the filter and static modules from the pinned [myguard-labs/nginx-zstd-module](https://github.com/myguard-labs/nginx-zstd-module) source revision. Brotli is not included.

Zstandard is the preferred response encoding when a client advertises it. Gzip remains enabled as a compatibility fallback, followed by the uncompressed identity representation:

```text
zstd → gzip → identity
```

The image and module are one release artifact. `docker/nginx/Dockerfile` compiles the dynamic modules against the exact `NGINX_VERSION` supplied by the final upstream image, installs only the runtime `libzstd` library, and checks that both modules load before completing the build.

## Configuration

The tracked configuration loads both modules in `config/nginx/nginx.conf` and enables dynamic and precompressed-static responses in `config/nginx/global/00-nginx.conf`:

```nginx
zstd on;
zstd_static on;
gzip_vary on;
```

The module's production defaults are used: compression level 3, a 1 KiB minimum response size, common web MIME types, and libzstd-sized streaming buffers. `gzip_vary on` is required so caches distinguish encoded and identity variants.

To serve precompressed static content, create a `.zst` sibling beside the original asset during deployment:

```text
app.js
app.js.zst
```

Nginx mounts `/home` read-only, so it cannot generate these files itself. Never use `zstd_static always`; normal `on` mode negotiates client support and safely falls back to the original file.

## Build and verify

```bash
./dc build nginx
./dc up -d --no-deps nginx
./dc exec -T nginx nginx -t
```

Test a compressible response larger than 1 KiB with a real GET:

```bash
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: zstd, gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: gzip' http://127.0.0.1/
curl -sS -D - -o /dev/null -H 'Host: example.com' -H 'Accept-Encoding: identity' http://127.0.0.1/
```

Expected encodings are `zstd`, `gzip`, and none. Encoded responses must include `Vary: Accept-Encoding`.

## Upgrades

The module commit is deliberately pinned in `docker/nginx/Dockerfile`. Review upstream changes and update the pin explicitly. Rebuild whenever either the Nginx base image or module revision changes, and verify amd64 and arm64 images before release.

Existing hosts must build and recreate Nginx before asking the old container to reload the new configuration, because the old image does not contain the Zstandard modules:

```bash
git pull
./dc build --pull nginx
./dc up -d --no-deps nginx
./dc exec -T nginx nginx -t
./manage.py apply
```

To disable response compression temporarily without changing the image, use a local replacement for the tracked global config with both `zstd off;` and `zstd_static off;`, then validate and reload Nginx. Keep the module load directives present unless the service is also moved to an image that omits the modules.
