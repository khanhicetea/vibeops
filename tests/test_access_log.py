"""App-scoped nginx access logs, rotation, and CLI wiring."""

from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.commands import access_log_commands
from bento.commands.parser import build_parser
from bento.services import access_log, nginx
from bento.utils import env
from bento.utils.errors import StackError
from bento.utils.paths import RenderContext


class AccessLogRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.generated = self.root / "runtime" / "generated"
        self.ctx = RenderContext(
            generated_dir=self.generated,
            secrets_dir=self.root / "runtime" / "secrets" / "mysql",
        )
        self.log_dir = self.root / "runtime" / "logs" / "nginx" / "apps"
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
            "access_log": False,
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_vhost_omits_access_log_when_disabled(self) -> None:
        with patch.object(access_log, "NGINX_ACCESS_LOG_DIR", self.log_dir):
            path = nginx.render_app_vhost(self.app, self.ctx)
        text = path.read_text()
        self.assertNotIn("access_log /var/log/nginx/apps/shop.access.log", text)

    def test_vhost_includes_access_log_when_enabled(self) -> None:
        self.app["access_log"] = True
        with patch.object(access_log, "NGINX_ACCESS_LOG_DIR", self.log_dir):
            path = nginx.render_app_vhost(self.app, self.ctx)
        text = path.read_text()
        self.assertEqual(text.count("access_log /var/log/nginx/apps/shop.access.log bento_combined buffer=64k flush=30s;"), 2)
        self.assertTrue(self.log_dir.is_dir())


class AccessLogRotateTests(unittest.TestCase):
    def test_app_rotation_uses_locked_container_implementation(self) -> None:
        completed = argparse.Namespace(stdout="maintenance output\nROTATED=1\n")
        with (
            patch.object(access_log, "docker_available", return_value=True),
            patch.object(access_log, "service_running", return_value=True),
            patch.object(access_log, "compose_prefix", return_value=["docker", "compose"]),
            patch.object(access_log, "run", return_value=completed) as run,
        ):
            self.assertTrue(access_log.rotate_app_access_log("shop", force=True))
        run.assert_called_once_with(
            [
                "docker", "compose", "exec", "-T", "nginx",
                "bento-nginx-maintenance", "rotate", "shop", "true",
            ],
            capture=True,
        )

    def test_all_rotation_returns_container_count(self) -> None:
        completed = argparse.Namespace(stdout="ROTATED=2\n")
        with (
            patch.object(access_log, "docker_available", return_value=True),
            patch.object(access_log, "service_running", return_value=True),
            patch.object(access_log, "run", return_value=completed),
        ):
            self.assertEqual(access_log.rotate_all_access_logs(), 2)

    def test_rotation_requires_running_nginx(self) -> None:
        with (
            patch.object(access_log, "docker_available", return_value=True),
            patch.object(access_log, "service_running", return_value=False),
            self.assertRaisesRegex(StackError, "nginx must be running"),
        ):
            access_log.rotate_all_access_logs()


class GoAccessAnalyzeTests(unittest.TestCase):
    def test_html_analysis_uses_request_time_format(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "logs"
            log_dir.mkdir()
            (log_dir / "shop.access.log").write_text(
                '127.0.0.1 - - [01/Jan/2026:12:34:56 +0000] '
                '"GET / HTTP/1.1" 200 12 "-" "curl" 0.125 0.120\n'
            )
            output = root / "report.html"
            with (
                patch.object(access_log, "NGINX_ACCESS_LOG_DIR", log_dir),
                patch.object(access_log, "docker_available", return_value=True),
                patch.object(access_log, "goaccess_image", return_value="goaccess:test"),
                patch.object(access_log, "run") as run,
            ):
                access_log.run_goaccess_analyze("shop", html_path=output)

        cmd = run.call_args.args[0]
        self.assertIn(
            '--log-format=%h %^[%d:%t %^] "%r" %s %b "%R" "%u" %T %^',
            cmd,
        )
        self.assertIn("--date-format=%d/%b/%Y", cmd)
        self.assertIn("--time-format=%H:%M:%S", cmd)
        self.assertNotIn("--log-format=COMBINED", cmd)


class AccessLogEnvTests(unittest.TestCase):
    def test_parse_byte_size(self) -> None:
        self.assertEqual(env.parse_byte_size("100"), 100)
        self.assertEqual(env.parse_byte_size("1K"), 1024)
        self.assertEqual(env.parse_byte_size("100M"), 100 * 1024 * 1024)
        self.assertEqual(env.parse_byte_size("2G"), 2 * 1024 * 1024 * 1024)

    def test_parse_byte_size_rejects_junk(self) -> None:
        with self.assertRaises(StackError):
            env.parse_byte_size("nope")


class AccessLogCliTests(unittest.TestCase):
    def test_parser_wiring(self) -> None:
        parser = build_parser()
        enable = parser.parse_args(["app", "access-log", "enable", "shop", "--no-reload"])
        self.assertEqual(enable.access_log_action, "enable")
        self.assertEqual(enable.app_name, "shop")
        self.assertTrue(enable.no_reload)
        analyze = parser.parse_args(["app", "logs", "analyze", "shop", "--html", "/tmp/x.html"])
        self.assertEqual(analyze.app_name, "shop")
        self.assertEqual(analyze.html, "/tmp/x.html")
        rotate = parser.parse_args(["logs", "rotate", "--force", "--app", "shop"])
        self.assertTrue(rotate.force)
        self.assertEqual(rotate.app_name, "shop")
        create = parser.parse_args(["app", "create", "shop", "shop.test", "--access-log"])
        self.assertTrue(create.access_log)
        create_off = parser.parse_args(["app", "create", "shop", "shop.test", "--no-access-log"])
        self.assertFalse(create_off.access_log)

    def test_enable_only_targets_nginx(self) -> None:
        db = {
            "apps": {
                "shop": {
                    "name": "shop",
                    "php_version": "8.5",
                    "main_domain": "shop.test",
                    "domains": ["shop.test"],
                    "access_log": False,
                }
            }
        }
        calls: list[dict] = []

        def fake_apply(_db, **kwargs):
            calls.append(kwargs)
            return []

        with (
            patch.object(access_log_commands, "load_db", return_value=db),
            patch.object(access_log_commands, "save_db"),
            patch.object(access_log_commands, "upsert_timestamp"),
            patch.object(access_log_commands, "info"),
            patch.object(access_log_commands, "ensure_access_log_dir"),
            patch("bento.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
        ):
            access_log_commands.cmd_app_access_log(
                argparse.Namespace(access_log_action="enable", app_name="shop", no_reload=False)
            )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["service_targets"], frozenset({"nginx"}))
        self.assertTrue(calls[0]["reload_services"])
        self.assertTrue(db["apps"]["shop"]["access_log"])

    def test_logs_rotate_command_app_scope(self) -> None:
        with patch.object(access_log_commands, "rotate_app_access_log", return_value=True) as rotate:
            with patch.object(access_log_commands, "info"):
                access_log_commands.cmd_logs_rotate(
                    argparse.Namespace(force=True, app_name="shop")
                )
        rotate.assert_called_once_with("shop", force=True)


if __name__ == "__main__":
    unittest.main()
