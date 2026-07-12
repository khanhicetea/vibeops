"""App-scoped custom vhost and PHP-FPM pool template tests."""

from __future__ import annotations

import argparse
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.commands import app_config_commands
from bento.commands.parser import build_parser
from bento.services import app_config, nginx, php
from bento.utils.paths import RenderContext
from bento.utils.errors import StackError


class AppConfigCustomizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.custom = self.root / "runtime" / "custom"
        self.generated = self.root / "runtime" / "generated"
        self.ctx = RenderContext(
            generated_dir=self.generated,
            secrets_dir=self.root / "runtime" / "secrets" / "mysql",
        )
        self.app = {
            "name": "shop",
            "uid": 10001,
            "php_version": "8.5",
            "main_domain": "shop.test",
            "domains": ["shop.test"],
            "public_dir": "",
            "php_entrypoint": "legacy",
            "fpm_profile": "balanced",
            "tls": {"mode": "self-signed"},
        }
        self.custom_patch = patch.object(app_config, "CUSTOM_DIR", self.custom)
        self.custom_patch.start()

    def tearDown(self) -> None:
        self.custom_patch.stop()
        self.tmp.cleanup()

    def test_customize_command_records_state_and_uses_scoped_validation(self) -> None:
        db = {"apps": {"shop": dict(self.app)}}
        with (
            patch.object(app_config_commands, "load_db", return_value=db),
            patch.object(app_config_commands, "save_db") as save,
            patch.object(app_config_commands, "info"),
            patch("bento.commands.runtime_commands.apply_generated_config") as apply,
        ):
            app_config_commands.cmd_app_config_customize(
                argparse.Namespace(app_name="shop", target="vhost", force=False, no_edit=True, no_reload=True)
            )
        record = db["apps"]["shop"]["service_config"]["vhost"]
        self.assertEqual(record["mode"], "custom")
        self.assertTrue(app_config.custom_template_path("shop", "vhost").is_file())
        self.assertEqual(apply.call_args.kwargs["service_targets"], frozenset({"nginx"}))
        self.assertTrue(apply.call_args.kwargs["validate_services"])
        self.assertFalse(apply.call_args.kwargs["reload_services"])
        save.assert_called_once_with(db)

    def test_cli_exposes_headless_config_commands(self) -> None:
        parser = build_parser()
        customize = parser.parse_args(["app", "config", "customize", "shop", "vhost", "--no-edit", "--no-reload"])
        self.assertEqual(customize.app_name, "shop")
        self.assertEqual(customize.target, "vhost")
        self.assertTrue(customize.no_edit)
        self.assertTrue(customize.no_reload)
        status = parser.parse_args(["app", "config", "status", "shop"])
        self.assertEqual(status.app_name, "shop")

    def test_editor_uses_visual_and_requires_success(self) -> None:
        source = self.root / "custom.conf"
        source.write_text("draft\n")
        with (
            patch.dict("os.environ", {"VISUAL": "code --wait", "EDITOR": "nano"}, clear=False),
            patch.object(app_config_commands.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run,
            patch.object(app_config_commands, "info"),
        ):
            app_config_commands.edit_custom_source(source)
        run.assert_called_once_with(["code", "--wait", str(source)], check=False)

    def test_failed_editor_does_not_activate_customization(self) -> None:
        db = {"apps": {"shop": dict(self.app)}}
        with (
            patch.object(app_config_commands, "load_db", return_value=db),
            patch.object(app_config_commands, "edit_custom_source", side_effect=StackError("editor failed")),
            patch.object(app_config_commands, "save_db") as save,
            patch("bento.commands.runtime_commands.apply_generated_config") as apply,
        ):
            with self.assertRaisesRegex(StackError, "editor failed"):
                app_config_commands.cmd_app_config_customize(
                    argparse.Namespace(app_name="shop", target="pool", force=False, no_edit=False, no_reload=False)
                )
        self.assertNotIn("service_config", db["apps"]["shop"])
        apply.assert_not_called()
        save.assert_not_called()
        self.assertTrue(app_config.custom_template_path("shop", "pool").is_file())

    def test_install_preserves_existing_source_unless_forced(self) -> None:
        path, created = app_config.install_custom_template("shop", "vhost")
        self.assertTrue(created)
        path.write_text("# operator edit\n")
        reused, created = app_config.install_custom_template("shop", "vhost")
        self.assertEqual(reused, path)
        self.assertFalse(created)
        self.assertEqual(path.read_text(), "# operator edit\n")
        _path, created = app_config.install_custom_template("shop", "vhost", force=True)
        self.assertTrue(created)
        self.assertIn("bento CUSTOM APP TEMPLATE", path.read_text())

    def test_custom_vhost_template_is_rendered_with_state_and_tls(self) -> None:
        source = app_config.custom_template_path("shop", "vhost")
        source.parent.mkdir(parents=True)
        source.write_text(
            "# custom-vhost-token\n"
            "server {\n"
            "    listen 443 ssl;\n"
            "    server_name ${MAIN_DOMAIN};\n"
            "    # BEGIN TLS_CERTIFICATE\n"
            "    ssl_certificate ignored;\n"
            "    ssl_certificate_key ignored;\n"
            "    # END TLS_CERTIFICATE\n"
            "}\n"
            "server {\n"
            "    listen 80;\n"
            "    server_name ${MAIN_DOMAIN};\n"
            "    set $enable_https_redirect 0;\n"
            "}\n"
        )
        app_config.set_config_record(self.app, "vhost", mode="custom", based_on_sha256="old")
        output = nginx.render_app_vhost(self.app, self.ctx)
        text = output.read_text()
        self.assertIn("custom-vhost-token", text)
        self.assertIn("server_name shop.test", text)
        self.assertIn("self-signed/default.crt", text)
        self.assertIn("GENERATED BY bento", text)

    def test_custom_pool_template_is_rendered_to_selected_php_version(self) -> None:
        source = app_config.custom_template_path("shop", "pool")
        source.parent.mkdir(parents=True)
        source.write_text(
            "; custom-pool-token\n"
            "[${USERNAME}]\n"
            "user = ${USERNAME}\n"
            "listen = /run/php-fpm/${USERNAME}.sock\n"
            "pm = ${PM}\n"
            "pm.max_children = ${PM_MAX_CHILDREN}\n"
        )
        app_config.set_config_record(self.app, "pool", mode="custom", based_on_sha256="old")
        socket_dir = self.root / "runtime" / "run" / "php-fpm"
        log_dir = self.root / "runtime" / "logs" / "php"
        with (
            patch.object(php, "PHP_SOCKET_DIR", socket_dir),
            patch.object(php, "PHP_LOG_DIR", log_dir),
            patch.object(php, "stack_env", return_value={"SOCKET_GROUP_NAME": "nginxsock"}),
        ):
            php.render_app_identity(self.app, self.ctx)
        output = self.generated / "php" / "versions" / "8.5" / "pool.d" / "shop.conf"
        text = output.read_text()
        self.assertIn("custom-pool-token", text)
        self.assertIn("[shop]", text)
        self.assertIn("pm.max_children = 6", text)
        self.assertTrue(text.startswith("; GENERATED BY bento"))

    def test_missing_selected_custom_source_fails_instead_of_falling_back(self) -> None:
        app_config.set_config_record(self.app, "pool", mode="custom", based_on_sha256="old")
        with self.assertRaisesRegex(StackError, "Missing custom pool template"):
            app_config.selected_template_path(self.app, "pool")

    def test_custom_source_cannot_escape_app_directory(self) -> None:
        self.app["service_config"] = {
            "vhost": {"mode": "custom", "source": "/tmp/other.conf"}
        }
        with self.assertRaisesRegex(StackError, "cannot point outside"):
            app_config.config_record(self.app, "vhost")

    def test_reset_keeps_provenance_for_future_reactivation(self) -> None:
        record = app_config.set_config_record(self.app, "vhost", mode="custom", based_on_sha256="abc")
        self.assertEqual(record["mode"], "custom")
        record = app_config.set_config_record(self.app, "vhost", mode="generated")
        self.assertEqual(record["mode"], "generated")
        self.assertEqual(record["based_on_sha256"], "abc")
        self.assertIn("source", record)


if __name__ == "__main__":
    unittest.main()
