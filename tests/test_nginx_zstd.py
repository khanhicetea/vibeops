from __future__ import annotations

import unittest
from pathlib import Path


class NginxZstdTests(unittest.TestCase):
    def test_compose_builds_the_bento_nginx_image(self) -> None:
        compose = Path("config/compose.yml").read_text()
        self.assertIn("      context: ./docker/nginx\n", compose)
        self.assertIn("        NGINX_BASE_IMAGE: nginx:${NGINX_VERSION:-1.30}-trixie\n", compose)
        self.assertIn("    image: bento/nginx:${NGINX_VERSION:-1.30}-zstd\n", compose)

    def test_image_builds_pinned_myguard_zstd_dynamic_modules(self) -> None:
        dockerfile = Path("docker/nginx/Dockerfile").read_text()
        self.assertIn("https://github.com/myguard-labs/nginx-zstd-module.git", dockerfile)
        self.assertIn("ZSTD_MODULE_COMMIT=74ea74df8b382e9bc819a41392336bd6dee036c4", dockerfile)
        self.assertIn("--add-dynamic-module=/usr/src/nginx-zstd-module", dockerfile)
        self.assertIn("-DZSTD_STATIC_LINKING_ONLY", dockerfile)
        self.assertIn("ngx_http_zstd_filter_module.so", dockerfile)
        self.assertIn("ngx_http_zstd_static_module.so", dockerfile)
        self.assertIn("nginx -t -c /tmp/nginx-zstd-test.conf", dockerfile)
        self.assertNotIn("brotli", dockerfile.lower())

    def test_s6_keeps_nginx_as_the_container_main_command(self) -> None:
        dockerfile = Path("docker/nginx/Dockerfile").read_text()
        compose = Path("config/compose.yml").read_text()
        maintenance = Path("docker/nginx/bin/bento-nginx-maintenance").read_text()

        self.assertIn('ENTRYPOINT ["/init"]', dockerfile)
        self.assertIn('CMD ["/docker-entrypoint.sh", "nginx", "-g", "daemon off;"]', dockerfile)
        self.assertIn("S6_BEHAVIOUR_IF_STAGE2_FAILS: \"2\"", compose)
        self.assertIn("flock -n 9", maintenance)
        self.assertIn("timeout --signal=TERM", maintenance)
        self.assertIn("logrotate --state", maintenance)
        self.assertIn("delaycompress", maintenance)
        self.assertIn("nginx -s reopen", maintenance)
        self.assertIn(".bento-logrotate.status", maintenance)
        self.assertNotIn('mv -- "$live"', maintenance)
        self.assertIn("        logrotate \\\n", dockerfile)

    def test_goaccess_reports_are_loopback_only(self) -> None:
        status = Path("config/nginx/global/02-status.conf").read_text()
        self.assertIn("listen 127.0.0.1:8080;", status)
        self.assertIn("location /goaccess/", status)
        self.assertIn("alias /var/log/nginx/goaccess/;", status)
        self.assertIn("allow 127.0.0.1;", status)
        self.assertIn("deny all;", status)

    def test_nginx_loads_and_enables_zstd_with_gzip_fallback(self) -> None:
        nginx_conf = Path("config/nginx/nginx.conf").read_text()
        global_conf = Path("config/nginx/global/00-nginx.conf").read_text()

        self.assertIn("load_module modules/ngx_http_zstd_filter_module.so;", nginx_conf)
        self.assertIn("load_module modules/ngx_http_zstd_static_module.so;", nginx_conf)
        self.assertIn("zstd on;", global_conf)
        self.assertIn("zstd_static on;", global_conf)
        self.assertIn("gzip on;", global_conf)
        self.assertIn("gzip_vary on;", global_conf)
        self.assertNotIn("brotli", nginx_conf.lower())
        self.assertNotIn("brotli", global_conf.lower())


if __name__ == "__main__":
    unittest.main()
