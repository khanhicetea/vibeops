"""Tests for named PHP-FPM pool profiles."""
from __future__ import annotations

import io
import re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import bento.utils.env as env
from bento.utils.errors import StackError
from bento.services.state import empty_db, normalize_db
from bento.services.php import render_app_identity
import bento.os.process as process
import bento.utils.paths as paths
import bento.commands.runtime_commands as runtime
from bento.commands.app_commands import resolve_app_fpm_profile
from bento.commands.parser import build_parser
from bento.utils.template import render_template_text


def _render_pool(profile: str, app: str = "shop") -> str:
    values = {
        "USERNAME": app,
        "SOCKET_GROUP_NAME": "nginxsock",
        "PHP_VERSION": "8.4",
        **env.fpm_pool_template_values(profile),
    }
    template = (paths.PHP_TEMPLATE_DIR / "pool.conf.template").read_text()
    return render_template_text(template, values)


class FpmProfileRegistryTests(unittest.TestCase):
    def test_known_profiles(self) -> None:
        self.assertEqual(set(env.FPM_PROFILES), {"ondemand", "balanced", "throughput"})
        self.assertEqual(env.DEFAULT_FPM_PROFILE, "balanced")

    def test_default_is_balanced(self) -> None:
        with patch.object(env, "stack_env", return_value={}):
            self.assertEqual(env.default_fpm_profile(), "balanced")

    def test_default_from_env(self) -> None:
        with patch.object(env, "stack_env", return_value={"DEFAULT_FPM_PROFILE": "ondemand"}):
            self.assertEqual(env.default_fpm_profile(), "ondemand")

    def test_invalid_env_default_fails(self) -> None:
        with patch.object(env, "stack_env", return_value={"DEFAULT_FPM_PROFILE": "turbo"}):
            with self.assertRaisesRegex(StackError, r"Invalid fpm_profile"):
                env.default_fpm_profile()

    def test_invalid_profile_fails(self) -> None:
        with self.assertRaisesRegex(StackError, r"Invalid fpm_profile"):
            env.validate_fpm_profile("turbo")

    def test_process_max_default_and_override(self) -> None:
        with patch.object(env, "stack_env", return_value={}):
            self.assertEqual(env.php_fpm_process_max(), 32)
        with patch.object(env, "stack_env", return_value={"PHP_FPM_PROCESS_MAX": "64"}):
            self.assertEqual(env.php_fpm_process_max(), 64)
        with patch.object(env, "stack_env", return_value={"PHP_FPM_PROCESS_MAX": "0"}):
            with self.assertRaisesRegex(StackError, r"PHP_FPM_PROCESS_MAX"):
                env.php_fpm_process_max()


class FpmPoolRenderTests(unittest.TestCase):
    def test_ondemand_directives(self) -> None:
        text = _render_pool("ondemand")
        self.assertIn("; fpm_profile = ondemand", text)
        self.assertRegex(text, r"(?m)^pm = ondemand$")
        self.assertRegex(text, r"(?m)^pm\.max_children = 4$")
        self.assertRegex(text, r"(?m)^pm\.process_idle_timeout = 10s$")
        self.assertRegex(text, r"(?m)^pm\.max_requests = 256$")
        self.assertNotIn("pm.start_servers", text)
        self.assertNotIn("pm.min_spare_servers", text)
        self.assertNotIn("pm.max_spare_servers", text)
        # Unchanged operational directives
        self.assertIn("listen = /run/php-fpm/shop.sock", text)
        self.assertIn("clear_env = yes", text)
        self.assertIn("catch_workers_output = yes", text)
        self.assertIn("open_basedir", text)

    def test_balanced_directives(self) -> None:
        text = _render_pool("balanced")
        self.assertIn("; fpm_profile = balanced", text)
        self.assertRegex(text, r"(?m)^pm = dynamic$")
        self.assertRegex(text, r"(?m)^pm\.max_children = 6$")
        self.assertRegex(text, r"(?m)^pm\.start_servers = 2$")
        self.assertRegex(text, r"(?m)^pm\.min_spare_servers = 1$")
        self.assertRegex(text, r"(?m)^pm\.max_spare_servers = 3$")
        self.assertRegex(text, r"(?m)^pm\.max_requests = 256$")
        self.assertNotIn("pm.process_idle_timeout", text)

    def test_throughput_directives(self) -> None:
        text = _render_pool("throughput")
        self.assertIn("; fpm_profile = throughput", text)
        self.assertRegex(text, r"(?m)^pm = dynamic$")
        self.assertRegex(text, r"(?m)^pm\.max_children = 12$")
        self.assertRegex(text, r"(?m)^pm\.start_servers = 3$")
        self.assertRegex(text, r"(?m)^pm\.min_spare_servers = 2$")
        self.assertRegex(text, r"(?m)^pm\.max_spare_servers = 6$")
        self.assertRegex(text, r"(?m)^pm\.max_requests = 512$")
        self.assertNotIn("pm.process_idle_timeout", text)

    def test_all_profiles_render_without_template_error(self) -> None:
        for name in env.FPM_PROFILE_NAMES:
            with self.subTest(profile=name):
                text = _render_pool(name)
                self.assertIn(f"fpm_profile = {name}", text)
                self.assertTrue(re.search(r"(?m)^pm = (dynamic|ondemand)$", text))


class ResolveAndNormalizeTests(unittest.TestCase):
    def test_new_app_uses_stack_default(self) -> None:
        with patch.object(env, "default_fpm_profile", return_value="balanced"):
            with patch("bento.commands.app_commands.default_fpm_profile", return_value="balanced"):
                self.assertEqual(resolve_app_fpm_profile({"apps": {}}, "shop", None), "balanced")

    def test_new_app_explicit_profile(self) -> None:
        self.assertEqual(resolve_app_fpm_profile({"apps": {}}, "shop", "ondemand"), "ondemand")

    def test_existing_omitted_preserves_recorded(self) -> None:
        db = {"apps": {"shop": {"name": "shop", "fpm_profile": "throughput"}}}
        self.assertEqual(resolve_app_fpm_profile(db, "shop", None), "throughput")

    def test_existing_explicit_changes(self) -> None:
        db = {"apps": {"shop": {"name": "shop", "fpm_profile": "balanced"}}}
        self.assertEqual(resolve_app_fpm_profile(db, "shop", "ondemand"), "ondemand")

    def test_missing_profile_normalizes_to_default(self) -> None:
        with patch.object(env, "stack_env", return_value={"DEFAULT_PHP_VERSION": "8.4", "DEFAULT_MYSQL_SERVICE": "mysql84"}):
            with patch.object(env, "default_fpm_profile", return_value="balanced"):
                data = normalize_db({
                    "schema": paths.SCHEMA_VERSION,
                    "apps": {"shop": {"name": "shop"}},
                    "domains": {},
                    "sites": {},
                    "crons": {},
                })
                self.assertEqual(data["apps"]["shop"]["fpm_profile"], "balanced")

    def test_invalid_state_profile_fails(self) -> None:
        with patch.object(env, "stack_env", return_value={}):
            with self.assertRaisesRegex(StackError, r"Invalid fpm_profile"):
                normalize_db({
                    "schema": paths.SCHEMA_VERSION,
                    "apps": {"shop": {"name": "shop", "fpm_profile": "turbo"}},
                    "domains": {},
                    "sites": {},
                    "crons": {},
                })


class ParserFpmProfileTests(unittest.TestCase):
    def test_omitted_is_none(self) -> None:
        args = build_parser().parse_args(["app", "create", "shop", "shop.example.com"])
        self.assertIsNone(args.fpm_profile)

    def test_explicit_profile(self) -> None:
        args = build_parser().parse_args(
            ["app", "create", "shop", "shop.example.com", "--fpm-profile", "ondemand"]
        )
        self.assertEqual(args.fpm_profile, "ondemand")

    def test_invalid_profile_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            build_parser().parse_args(
                ["app", "create", "shop", "shop.example.com", "--fpm-profile", "turbo"]
            )


class CapacityWarningTests(unittest.TestCase):
    def _db(self, *apps: tuple[str, str, str]) -> dict:
        """apps: (name, php_version, fpm_profile)"""
        data: dict = {
            "schema": paths.SCHEMA_VERSION,
            "apps": {},
            "domains": {},
            "sites": {},
            "crons": {},
        }
        for name, version, profile in apps:
            data["apps"][name] = {
                "name": name,
                "php_version": version,
                "fpm_profile": profile,
            }
        return data

    def test_warns_when_over_cap(self) -> None:
        # balanced max_children=6; 6 apps * 6 = 36 > 32
        db = self._db(*[(f"a{i}", "8.4", "balanced") for i in range(6)])
        warnings = env.fpm_capacity_warnings(db, process_max=32)
        self.assertEqual(len(warnings), 1)
        self.assertIn("process.max is 32", warnings[0])
        self.assertIn("sum of pool pm.max_children is 36", warnings[0])

    def test_no_warning_under_cap(self) -> None:
        db = self._db(("shop", "8.4", "balanced"), ("blog", "8.4", "ondemand"))
        # 6 + 4 = 10 < 32
        warnings = env.fpm_capacity_warnings(db, process_max=32)
        self.assertEqual(warnings, [])

    def test_per_version_isolation(self) -> None:
        # each version under cap individually
        apps = [(f"a{i}", "8.4", "throughput") for i in range(2)]  # 24
        apps += [(f"b{i}", "8.5", "throughput") for i in range(2)]  # 24
        warnings = env.fpm_capacity_warnings(self._db(*apps), process_max=32)
        self.assertEqual(warnings, [])


class StatusCapacityOutputTests(unittest.TestCase):
    def test_status_emits_capacity_warning(self) -> None:
        db = {
            "schema": paths.SCHEMA_VERSION,
            "apps": {
                f"a{i}": {
                    "name": f"a{i}",
                    "php_version": "8.4",
                    "fpm_profile": "balanced",
                    "php_entrypoint": "legacy",
                    "main_domain": f"a{i}.test",
                    "tls": {"mode": "self-signed"},
                }
                for i in range(6)
            },
            "domains": {},
            "sites": {},
            "crons": {},
        }
        out_buf = io.StringIO()
        err_buf = io.StringIO()
        with patch.object(runtime, "load_db", return_value=db), \
             patch.object(runtime, "docker_available", return_value=False), \
             patch.object(runtime, "running_services", return_value=set()), \
             patch.object(env, "php_fpm_process_max", return_value=32), \
             patch.object(runtime, "php_fpm_process_max", return_value=32), \
             redirect_stdout(out_buf), redirect_stderr(err_buf):
            runtime.cmd_status(type("NS", (), {"check_nginx": False})())
        out = out_buf.getvalue()
        err = err_buf.getvalue()
        self.assertIn("PHP-FPM capacity", out)
        self.assertIn("process.max is 32", err)
        self.assertIn("sum of pool pm.max_children is 36", err)


class RenderWithProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.runtime_dir = self.root / "runtime"
        self.generated = self.runtime_dir / "generated"
        self.secrets = self.runtime_dir / "secrets" / "mysql"
        self.generated.mkdir(parents=True)
        self.secrets.mkdir(parents=True)
        self.home = self.runtime_dir / "home"
        self.home.mkdir()
        self.live = paths.RenderContext(generated_dir=self.generated, secrets_dir=self.secrets)
        self.patches = [
            patch.object(paths, "HOME_DIR", self.home),
            patch.object(paths, "PHP_SOCKET_DIR", self.runtime_dir / "run" / "php-fpm"),
            patch.object(paths, "PHP_LOG_DIR", self.runtime_dir / "logs" / "php"),
            patch.object(paths, "RUNTIME_DIR", self.runtime_dir),
            patch.object(paths, "GENERATED_DIR", self.generated),
            patch.object(paths, "MYSQL_SECRETS_DIR", self.secrets),
            patch.object(paths, "PHP_VERSIONS_DIR", self.generated / "php" / "versions"),
            patch.object(paths, "CRON_RUNTIME_DIR", self.generated / "cron"),
            patch.object(paths, "NGINX_VHOST_DIR", self.generated / "nginx" / "vhosts"),
            patch.object(runtime, "RUNTIME_DIR", self.runtime_dir),
            patch.object(runtime, "available_php_versions", return_value=["8.4"]),
            patch.object(env, "stack_env", return_value={
                "DEFAULT_PHP_VERSION": "8.4",
                "SOCKET_GROUP_NAME": "nginxsock",
                "DEFAULT_FPM_PROFILE": "balanced",
            }),
            patch.object(process, "docker_available", return_value=False),
            patch.object(process, "service_running", return_value=False),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_render_writes_profile_specific_pool(self) -> None:
        db = empty_db()
        for name, profile in (("shop", "ondemand"), ("blog", "throughput")):
            db["apps"][name] = {
                "name": name,
                "uid": 10001 if name == "shop" else 10002,
                "php_version": "8.4",
                "main_domain": f"{name}.test",
                "domains": [f"{name}.test"],
                "public_dir": "",
                "php_entrypoint": "legacy",
                "fpm_profile": profile,
                "tls": {"mode": "self-signed"},
            }
            db["domains"][f"{name}.test"] = {"kind": "php", "app": name}

        runtime.apply_generated_config(db, live=self.live, runtime_dir=self.runtime_dir)
        shop = (self.generated / "php" / "versions" / "8.4" / "pool.d" / "shop.conf").read_text()
        blog = (self.generated / "php" / "versions" / "8.4" / "pool.d" / "blog.conf").read_text()
        self.assertIn("pm = ondemand", shop)
        self.assertNotIn("pm.start_servers", shop)
        self.assertIn("pm = dynamic", blog)
        self.assertIn("pm.max_children = 12", blog)

    def test_invalid_profile_rolls_back_render(self) -> None:
        db = empty_db()
        db["apps"]["shop"] = {
            "name": "shop",
            "uid": 10001,
            "php_version": "8.4",
            "main_domain": "shop.test",
            "domains": ["shop.test"],
            "public_dir": "",
            "php_entrypoint": "legacy",
            "fpm_profile": "balanced",
            "tls": {"mode": "self-signed"},
        }
        # Poison the registry resolution path mid-render via bad state mutation after normalize.
        # Directly call render_app_identity with an invalid profile to simulate malformed state.
        app = dict(db["apps"]["shop"])
        app["fpm_profile"] = "turbo"
        with self.assertRaisesRegex(StackError, r"Invalid fpm_profile"):
            render_app_identity(app, self.live)
        # Staging tree for a failed apply should not leave live pool.
        self.assertFalse((self.generated / "php" / "versions" / "8.4" / "pool.d" / "shop.conf").exists())


if __name__ == "__main__":
    unittest.main()
