"""Webhook deploy configuration and rendering tests."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.services import deploy as deploy_svc
from bento.services.deploy import (
    DEPLOY_SKIP_EXIT_CODE,
    default_command,
    deploy_enabled,
    ensure_deploy_runtime,
    normalize_deploy,
    new_webhook_secret,
    sync_deploy_cron,
    write_deploy_config,
    write_example_deploy_script,
)
from bento.services.nginx import render_app_vhost
from bento.utils.errors import StackError
from bento.utils.paths import RenderContext
from bento.utils.template import render_template_text


class DeployNormalizeTests(unittest.TestCase):
    def test_defaults(self) -> None:
        secret = new_webhook_secret()
        deploy = normalize_deploy(
            "shop",
            {"enabled": True, "webhook_secret": secret},
            php_version="8.5",
        )
        self.assertTrue(deploy["enabled"])
        self.assertEqual(deploy["timeout"], 900)
        self.assertEqual(deploy["queue_policy"], "latest")
        self.assertEqual(deploy["command"], default_command("shop"))
        self.assertEqual(deploy["webhook_secret"], secret)

    def test_requires_secret_when_enabled(self) -> None:
        with self.assertRaises(StackError):
            normalize_deploy("shop", {"enabled": True})

    def test_disabled_without_secret(self) -> None:
        deploy = normalize_deploy("shop", {"enabled": False})
        self.assertFalse(deploy["enabled"])
        self.assertEqual(deploy["webhook_secret"], "")

    def test_queue_policy_validation(self) -> None:
        with self.assertRaises(StackError):
            normalize_deploy("shop", {"enabled": False, "queue_policy": "bogus"})

    def test_skip_exit_code_constant(self) -> None:
        self.assertEqual(DEPLOY_SKIP_EXIT_CODE, 99)


class DeployRuntimeTests(unittest.TestCase):
    def test_ensure_runtime_and_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            with patch.object(deploy_svc, "HOME_DIR", home), patch.object(
                deploy_svc, "app_home", lambda name: home / name
            ):
                ensure_deploy_runtime("shop")
                deploy = normalize_deploy(
                    "shop",
                    {
                        "enabled": True,
                        "webhook_secret": "a" * 64,
                        "timeout": 120,
                        "queue_policy": "fifo",
                    },
                )
                cfg = write_deploy_config("shop", deploy)
                self.assertTrue(cfg.is_file())
                data = json.loads(cfg.read_text())
                self.assertEqual(data["timeout"], 120)
                self.assertEqual(data["queue_policy"], "fifo")
                self.assertNotIn("webhook_secret", data)
                script = write_example_deploy_script("shop")
                self.assertTrue(script.is_file())
                self.assertIn(str(DEPLOY_SKIP_EXIT_CODE), script.read_text())
                queue = home / "shop" / ".bento" / "queue.json"
                self.assertTrue(queue.is_file())


class DeployCronSyncTests(unittest.TestCase):
    def test_sync_creates_and_removes_managed_cron(self) -> None:
        db = {
            "apps": {
                "shop": {
                    "name": "shop",
                    "php_version": "8.5",
                    "deploy": {
                        "enabled": True,
                        "webhook_secret": "b" * 64,
                        "timeout": 300,
                        "workdir": "/home/shop/www",
                        "command": ["sh", "/home/shop/.bento/deploy.sh"],
                        "queue_policy": "latest",
                    },
                }
            },
            "crons": {},
        }
        sync_deploy_cron(db, "shop")
        self.assertIn("shop/bento-deploy-drain", db["crons"])
        cron = db["crons"]["shop/bento-deploy-drain"]
        self.assertEqual(cron["schedule"], "* * * * *")
        self.assertEqual(cron["lock"], "deploy")
        self.assertEqual(cron["output"], "file")
        self.assertEqual(cron["timeout"], 300)
        self.assertIn("bento-deploy-drain", cron["command"])

        db["apps"]["shop"]["deploy"]["enabled"] = False
        sync_deploy_cron(db, "shop")
        self.assertNotIn("shop/bento-deploy-drain", db["crons"])


class DeployVhostTemplateTests(unittest.TestCase):
    def test_template_includes_bento_location_when_enabled(self) -> None:
        text = Path("config/nginx/templates/site.conf.template").read_text()
        rendered = render_template_text(
            text,
            {
                "APP_NAME": "shop",
                "SERVER_DOMAINS": ["shop.example.com"],
                "DOCUMENT_ROOT": "/home/shop/www",
                "PHP_SERVICE": "php85",
                "PHP_FRONT_CONTROLLER": True,
                "ACCESS_LOG": False,
                "DEPLOY_ENABLED": True,
                "DEPLOY_WEBHOOK_SECRET": "deadbeef",
                "DEPLOY_QUEUE_POLICY": "latest",
            },
        )
        self.assertEqual(rendered.count("location ^~ /_bento"), 1)
        self.assertIn("DEPLOY_WEBHOOK_SECRET deadbeef", rendered)
        self.assertIn("/usr/local/lib/bento/index.php", rendered)
        self.assertIn("/usr/local/lib/bento/", rendered)
        # Deploy webhook is HTTPS-only (443 block), not on the HTTP :80 server.
        https_block, http_block = rendered.split("listen 80;", 1)
        self.assertIn("location ^~ /_bento", https_block)
        self.assertNotIn("location ^~ /_bento", http_block)

    def test_template_omits_bento_location_when_disabled(self) -> None:
        text = Path("config/nginx/templates/site.conf.template").read_text()
        rendered = render_template_text(
            text,
            {
                "APP_NAME": "shop",
                "SERVER_DOMAINS": ["shop.example.com"],
                "DOCUMENT_ROOT": "/home/shop/www",
                "PHP_SERVICE": "php85",
                "PHP_FRONT_CONTROLLER": False,
                "ACCESS_LOG": False,
                "DEPLOY_ENABLED": False,
                "DEPLOY_WEBHOOK_SECRET": "",
                "DEPLOY_QUEUE_POLICY": "latest",
            },
        )
        self.assertNotIn("location ^~ /_bento", rendered)

    def test_render_app_vhost_writes_deploy_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generated = root / "generated"
            secrets = root / "secrets"
            home = root / "home"
            (home / "shop").mkdir(parents=True)
            ctx = RenderContext(generated_dir=generated, secrets_dir=secrets)
            app = {
                "name": "shop",
                "main_domain": "shop.example.com",
                "domains": ["shop.example.com"],
                "php_version": "8.5",
                "public_dir": "",
                "php_entrypoint": "legacy",
                "access_log": False,
                "tls": {"mode": "self-signed"},
                "deploy": {
                    "enabled": True,
                    "webhook_secret": "c" * 64,
                    "timeout": 900,
                    "queue_policy": "latest",
                    "workdir": "/home/shop/www",
                    "command": ["sh", "/home/shop/.bento/deploy.sh"],
                },
            }
            with patch.object(deploy_svc, "HOME_DIR", home), patch.object(
                deploy_svc, "app_home", lambda name: home / name
            ):
                path = render_app_vhost(app, ctx)
            conf = path.read_text()
            self.assertEqual(conf.count("location ^~ /_bento"), 1)
            https_block, http_block = conf.split("listen 80;", 1)
            self.assertIn("location ^~ /_bento", https_block)
            self.assertNotIn("location ^~ /_bento", http_block)
            self.assertIn("c" * 64, conf)
            self.assertTrue((home / "shop" / ".bento" / "deploy.json").is_file())
            self.assertTrue(deploy_enabled(app))


class DeployComposeMountTests(unittest.TestCase):
    def test_php_compose_includes_deploy_mounts(self) -> None:
        from bento.services.php_versions import render_php_versions_compose

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bento-php-versions.yml"
            render_php_versions_compose({"php_versions": ["8.5"]}, path=path)
            text = path.read_text()
            self.assertIn("bento-deploy-drain", text)
            self.assertIn("docker/php/lib/bento:/usr/local/lib/bento:ro", text)
            self.assertNotIn("php-deploy-init", text)
            self.assertNotIn("deploy-webhook.php", text)


if __name__ == "__main__":
    unittest.main()
