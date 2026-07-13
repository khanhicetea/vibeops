from __future__ import annotations

import argparse
import copy
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import bento.utils.env as env
from bento.utils.errors import StackError
from bento.services.php import php_version_config_dir
from bento.commands.app_commands import ensure_app, resolve_app_php_version
from bento.commands.parser import build_parser
from bento.commands import app_commands, cron_commands, runtime_commands


def _shop_db(php_version: str = "8.5") -> dict:
    return {
        "schema": 1,
        "defaults": {"php_version": "8.4", "mysql_service": "mysql84"},
        "apps": {
            "shop": {
                "name": "shop",
                "php_version": php_version,
                "php_service": "php" + php_version.replace(".", ""),
                "main_domain": "shop.example.com",
                "domains": ["shop.example.com"],
            }
        },
        "domains": {"shop.example.com": {"kind": "php", "app": "shop"}},
        "crons": {},
        "proxies": {},
        "sites": {},
        "users": {},
    }


class ParserPhpDefaultTests(unittest.TestCase):
    def test_omitted_php_is_none_for_app_scoped_commands(self) -> None:
        parser = build_parser()
        cases = [
            ["app", "create", "shop", "shop.example.com"],
            ["cron", "create", "shop", "job", "* * * * *", "true"],
            ["exec", "shop", "--", "php", "-v"],
            ["shell", "shop"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                args = parser.parse_args(argv)
                self.assertIsNone(args.php)

    def test_explicit_php_is_exact_string(self) -> None:
        parser = build_parser()
        cases = [
            (["app", "create", "shop", "shop.example.com", "--php", "8.5"], "8.5"),
            (["cron", "create", "shop", "job", "* * * * *", "true", "--php", "8.5"], "8.5"),
            # Options must precede app_name: nargs=REMAINDER for command swallows later flags.
            (["exec", "--php", "8.4", "shop", "--", "php", "-v"], "8.4"),
            (["shell", "shop", "--php", "8.5"], "8.5"),
        ]
        for argv, expected in cases:
            with self.subTest(argv=argv):
                args = parser.parse_args(argv)
                self.assertEqual(args.php, expected)


class ResolveAppPhpVersionTests(unittest.TestCase):
    def test_existing_omitted_uses_recorded(self) -> None:
        self.assertEqual(resolve_app_php_version(_shop_db(), "shop", None), "8.5")

    def test_existing_same_version(self) -> None:
        self.assertEqual(resolve_app_php_version(_shop_db(), "shop", "8.5"), "8.5")

    def test_existing_mismatch_raises_and_does_not_mutate(self) -> None:
        db = _shop_db()
        original = copy.deepcopy(db["apps"]["shop"])
        with self.assertRaisesRegex(StackError, r"primary PHP version is 8\.5, not 8\.4"):
            resolve_app_php_version(db, "shop", "8.4")
        self.assertEqual(db["apps"]["shop"], original)

    def test_unknown_omitted_uses_default(self) -> None:
        with patch.object(env, "default_php_version", return_value="8.4"):
            # resolve imports via wildcard into app_commands namespace
            with patch.object(app_commands, "default_php_version", return_value="8.4"):
                self.assertEqual(resolve_app_php_version({"apps": {}}, "newapp", None), "8.4")

    def test_unknown_explicit(self) -> None:
        self.assertEqual(resolve_app_php_version({"apps": {}}, "newapp", "8.5"), "8.5")

    def test_unknown_not_allow_new(self) -> None:
        with self.assertRaisesRegex(StackError, r"Unknown app: newapp"):
            resolve_app_php_version({"apps": {}}, "newapp", None, allow_new=False)

    def test_malformed_recorded_version(self) -> None:
        db = _shop_db()
        db["apps"]["shop"]["php_version"] = "not-a-version"
        with self.assertRaisesRegex(StackError, r"Invalid PHP version"):
            resolve_app_php_version(db, "shop", None)

    def test_missing_recorded_version(self) -> None:
        db = _shop_db()
        del db["apps"]["shop"]["php_version"]
        with self.assertRaisesRegex(StackError, r"no recorded php_version"):
            resolve_app_php_version(db, "shop", None)


class EnsureAppInvariantTests(unittest.TestCase):
    def test_rejects_different_primary_version_without_identity_call(self) -> None:
        db = _shop_db("8.5")
        with patch.object(app_commands, "ensure_app_identity") as identity:
            with self.assertRaisesRegex(StackError, r"primary PHP version is 8\.5, not 8\.4"):
                ensure_app("shop", "8.4", db)
            identity.assert_not_called()
            self.assertEqual(db["apps"]["shop"]["php_version"], "8.5")


class CommandHandlerPhpResolutionTests(unittest.TestCase):
    def _identity_path(self, version: str = "8.5", app: str = "shop") -> Path:
        return php_version_config_dir(version) / "users.d" / f"{app}.env"

    def test_exec_omitted_selects_app_cli_service(self) -> None:
        db = _shop_db("8.5")
        identity = MagicMock()
        identity.exists.return_value = True
        with (
            patch.object(runtime_commands, "load_db", return_value=db),
            patch.object(runtime_commands, "php_version_config_dir", side_effect=lambda v: Path(f"/tmp/php/{v}")),
            patch.object(Path, "exists", return_value=True),
            patch.object(runtime_commands, "ensure_app", return_value=db["apps"]["shop"]) as ensure,
            patch.object(runtime_commands, "save_db") as save_db,
            patch.object(runtime_commands, "docker_available", return_value=True),
            patch.object(runtime_commands, "render_php_versions_compose") as render_compose,
            patch.object(runtime_commands, "os") as os_mod,
            patch.object(runtime_commands.sys.stdin, "isatty", return_value=False),
            patch.object(runtime_commands.sys.stdout, "isatty", return_value=False),
        ):
            os_mod.execvp.side_effect = SystemExit(0)
            args = argparse.Namespace(app_name="shop", php=None, workdir=None, command=["php", "-v"])
            with self.assertRaises(SystemExit):
                runtime_commands.cmd_app_exec(args)
            ensure.assert_called_once_with("shop", "8.5", db)
            render_compose.assert_called_once_with(db)
            save_db.assert_not_called()
            cmd = os_mod.execvp.call_args[0][1]
            self.assertIn("php85-cli", cmd)

    def test_shell_omitted_selects_app_php(self) -> None:
        db = _shop_db("8.5")
        with (
            patch.object(runtime_commands, "load_db", return_value=db),
            patch.object(runtime_commands, "php_version_config_dir", side_effect=lambda v: Path(f"/tmp/php/{v}")),
            patch.object(Path, "exists", return_value=True),
            patch.object(runtime_commands, "ensure_app", return_value=db["apps"]["shop"]),
            patch.object(runtime_commands, "save_db") as save_db,
            patch.object(runtime_commands, "docker_available", return_value=True),
            patch.object(runtime_commands, "render_php_versions_compose") as render_compose,
            patch.object(runtime_commands, "os") as os_mod,
            patch.object(runtime_commands.sys.stdin, "isatty", return_value=False),
            patch.object(runtime_commands.sys.stdout, "isatty", return_value=False),
        ):
            os_mod.execvp.side_effect = SystemExit(0)
            args = argparse.Namespace(app_name="shop", php=None, workdir=None, shell="bash", command=None)
            with self.assertRaises(SystemExit):
                runtime_commands.cmd_app_shell(args)
            cmd = os_mod.execvp.call_args[0][1]
            self.assertIn("php85-cli", cmd)
            render_compose.assert_called_once_with(db)
            save_db.assert_not_called()

    def test_cron_omitted_stores_recorded_php(self) -> None:
        db = _shop_db("8.5")
        with (
            patch.object(cron_commands, "cron_state_lock") as lock,
            patch.object(cron_commands, "load_db", return_value=db),
            patch.object(cron_commands, "ensure_app", return_value=db["apps"]["shop"]),
            patch.object(cron_commands, "save_db"),
            patch.object(cron_commands, "stack_env", return_value={"TZ": "UTC"}),
            patch.object(cron_commands, "info"),
            patch.object(cron_commands, "rel", side_effect=lambda p: str(p)),
            patch.object(runtime_commands, "apply_generated_config", return_value=[]) as apply,
        ):
            lock.return_value.__enter__ = lambda s: None
            lock.return_value.__exit__ = lambda s, *a: False
            args = argparse.Namespace(
                app_name="shop",
                job_name="schedule",
                schedule="* * * * *",
                command="php artisan schedule:run",
                php=None,
                workdir=None,
                timezone=None,
                output="docker",
                timeout=0,
                lock=None,
            )
            cron_commands.cmd_cron_create(args)
            self.assertEqual(db["crons"]["shop/schedule"]["php_version"], "8.5")
            apply.assert_called_once()
            self.assertEqual(set(apply.call_args.kwargs["service_targets"]), {"runner"})

    def test_explicit_mismatch_fails_before_side_effects(self) -> None:
        db = _shop_db("8.5")
        original = copy.deepcopy(db["apps"]["shop"])
        with (
            patch.object(runtime_commands, "load_db", return_value=db),
            patch.object(runtime_commands, "ensure_app") as ensure,
            patch.object(runtime_commands, "save_db") as save_db,
            patch.object(runtime_commands, "docker_available") as docker,
            patch.object(runtime_commands, "os") as os_mod,
        ):
            args = argparse.Namespace(app_name="shop", php="8.4", workdir=None, command=["php", "-v"])
            with self.assertRaisesRegex(StackError, r"primary PHP version is 8\.5, not 8\.4"):
                runtime_commands.cmd_app_exec(args)
            ensure.assert_not_called()
            save_db.assert_not_called()
            docker.assert_not_called()
            os_mod.execvp.assert_not_called()
            self.assertEqual(db["apps"]["shop"], original)

        with (
            patch.object(cron_commands, "cron_state_lock") as lock,
            patch.object(cron_commands, "load_db", return_value=db),
            patch.object(cron_commands, "ensure_app") as ensure,
            patch.object(cron_commands, "save_db") as save_db,
            patch.object(runtime_commands, "apply_generated_config") as apply,
        ):
            lock.return_value.__enter__ = lambda s: None
            lock.return_value.__exit__ = lambda s, *a: False
            args = argparse.Namespace(
                app_name="shop",
                job_name="schedule",
                schedule="* * * * *",
                command="true",
                php="8.4",
                workdir=None,
                timezone=None,
                output="docker",
                timeout=0,
                lock=None,
            )
            with self.assertRaisesRegex(StackError, r"primary PHP version is 8\.5, not 8\.4"):
                cron_commands.cmd_cron_create(args)
            ensure.assert_not_called()
            apply.assert_not_called()
            save_db.assert_not_called()
            self.assertEqual(db["apps"]["shop"], original)

    def test_app_create_omitted_preserves_recorded_version(self) -> None:
        db = _shop_db("8.5")
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "ensure_app_identity", return_value=db["apps"]["shop"]) as identity,
            patch.object(app_commands, "assert_domain_free"),
            patch.object(app_commands, "mkdir"),
            patch.object(app_commands, "app_document_root", return_value=Path("/tmp/home/shop/www")),
            patch.object(app_commands, "apply_app_mysql_metadata"),
            patch.object(app_commands, "save_db"),
            patch.object(app_commands, "initialize_app_permissions"),
            patch.object(app_commands, "nginx_reload"),
            patch.object(app_commands, "info"),
            patch.object(app_commands, "rel", side_effect=lambda p: str(p)),
            patch.object(app_commands, "upsert_timestamp"),
            patch.object(app_commands, "app_vhost_path", return_value=Path("/tmp/app-shop.conf")),
        ):
            import bento.commands.runtime_commands as runtime_commands

            with patch.object(runtime_commands, "apply_generated_config", return_value=[Path("/tmp/app-shop.conf")]):
                args = argparse.Namespace(
                    app_name="shop",
                    main_domain="shop.example.com",
                    db_suffix=None,
                    php=None,
                    mysql_service="mysql84",
                    alias=None,
                    aliases=None,
                    public_dir="",
                    php_entrypoint="auto",
                    no_index=True,
                    no_reload=True,
                    uid=None,
                    no_mysql=True,
                    mysql_password=None,
                )
                app_commands.cmd_app_create(args)
                identity.assert_called_once()
                self.assertEqual(identity.call_args[0][1], "8.5")

    def test_new_app_omitted_uses_stack_default(self) -> None:
        db = {"php_versions": ["8.4"], "apps": {}, "domains": {}, "crons": {}, "proxies": {}}
        created = {"name": "fresh", "php_version": "8.4"}
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "default_php_version", return_value="8.4"),
            patch.object(app_commands, "ensure_app_identity", return_value=created) as identity,
            patch.object(app_commands, "assert_domain_free"),
            patch.object(app_commands, "mkdir"),
            patch.object(app_commands, "app_document_root", return_value=Path("/tmp/home/fresh/www")),
            patch.object(app_commands, "apply_app_mysql_metadata"),
            patch.object(app_commands, "save_db"),
            patch.object(app_commands, "initialize_app_permissions"),
            patch.object(app_commands, "nginx_reload"),
            patch.object(app_commands, "info"),
            patch.object(app_commands, "rel", side_effect=lambda p: str(p)),
            patch.object(app_commands, "upsert_timestamp"),
            patch.object(app_commands, "app_vhost_path", return_value=Path("/tmp/app-fresh.conf")),
        ):
            import bento.commands.runtime_commands as runtime_commands

            with patch.object(runtime_commands, "apply_generated_config", return_value=[Path("/tmp/app-fresh.conf")]):
                args = argparse.Namespace(
                    app_name="fresh",
                    main_domain="fresh.example.com",
                    db_suffix=None,
                    php=None,
                    mysql_service="mysql84",
                    alias=None,
                    aliases=None,
                    public_dir="",
                    php_entrypoint="auto",
                    no_index=True,
                    no_reload=True,
                    uid=None,
                    no_mysql=True,
                    mysql_password=None,
                )
                app_commands.cmd_app_create(args)
                self.assertEqual(identity.call_args[0][1], "8.4")

    def test_app_create_explicit_migration_allowed(self) -> None:
        db = _shop_db("8.5")
        db["php_versions"] = ["8.4", "8.5"]
        migrated = dict(db["apps"]["shop"], php_version="8.4")
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "ensure_app_identity", return_value=migrated) as identity,
            patch.object(app_commands, "assert_domain_free"),
            patch.object(app_commands, "mkdir"),
            patch.object(app_commands, "app_document_root", return_value=Path("/tmp/home/shop/www")),
            patch.object(app_commands, "apply_app_mysql_metadata"),
            patch.object(app_commands, "save_db"),
            patch.object(app_commands, "initialize_app_permissions"),
            patch.object(app_commands, "nginx_reload"),
            patch.object(app_commands, "info"),
            patch.object(app_commands, "rel", side_effect=lambda p: str(p)),
            patch.object(app_commands, "upsert_timestamp"),
            patch.object(app_commands, "app_vhost_path", return_value=Path("/tmp/app-shop.conf")),
        ):
            import bento.commands.runtime_commands as runtime_commands

            with patch.object(runtime_commands, "apply_generated_config", return_value=[Path("/tmp/app-shop.conf")]):
                args = argparse.Namespace(
                    app_name="shop",
                    main_domain="shop.example.com",
                    db_suffix=None,
                    php="8.4",
                    mysql_service="mysql84",
                    alias=None,
                    aliases=None,
                    public_dir="",
                    php_entrypoint="auto",
                    no_index=True,
                    no_reload=True,
                    uid=None,
                    no_mysql=True,
                    mysql_password=None,
                )
                app_commands.cmd_app_create(args)
                self.assertEqual(identity.call_args[0][1], "8.4")


if __name__ == "__main__":
    unittest.main()
