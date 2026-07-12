"""Contract tests: each mutation reloads only the services it actually changes.

Reload matrix (service signals only — generated files may still re-render):

| Command                    | nginx | php-fpm | runner |
|----------------------------|:-----:|:-------:|:------:|
| app domain add/remove/main |  Y    |    -    |  -   |
| app access-log enable/off  |  Y    |    -    |  -   |
| proxy create / tls *       |  Y    |    -    |  -   |
| app create (new identity)  |  Y    |    Y    |  -   |
| cron create/remove/reload  |  -    |    -    |  Y   |
| app db create / db create  |  -    |    -    |  -   |
| db user-reset / backup/*   |  -    |    -    |  -   |
| apply (full)               |  Y    |    Y    |  Y   |
| render                     |  -    |    -    |  -   |
| shell / exec (existing)    |  -    |    -    |  -   |
"""
from __future__ import annotations

import argparse
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import vibeops.commands.app_commands as app_commands
import vibeops.commands.cron_commands as cron_commands
import vibeops.commands.db_commands as db_commands
import vibeops.commands.proxy_commands as proxy_commands
import vibeops.commands.runtime_commands as runtime
import vibeops.commands.tls_commands as tls_commands


def _db_with_app() -> dict:
    return {
        "schema": 5,
        "defaults": {"php_version": "8.5", "mysql_service": "mysql84"},
        "apps": {
            "shop": {
                "name": "shop",
                "php_version": "8.5",
                "php_service": "php85",
                "main_domain": "shop.example.com",
                "domains": ["shop.example.com"],
                "databases": [],
                "database_services": {},
                "mysql_service": "mysql84",
                "tls": {"mode": "self-signed"},
            }
        },
        "domains": {"shop.example.com": {"kind": "php", "app": "shop"}},
        "sites": {},
        "crons": {},
        "users": {},
    }


class ReloadScopeTests(unittest.TestCase):
    def _track_apply(self) -> tuple[list[dict], object]:
        calls: list[dict] = []

        def fake_apply(_db, **kwargs):
            calls.append(kwargs)
            return [Path("/tmp/generated.conf")]

        return calls, fake_apply

    def test_domain_add_only_targets_nginx(self) -> None:
        db = _db_with_app()
        calls, fake_apply = self._track_apply()
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "save_db"),
            patch.object(app_commands, "assert_domain_free"),
            patch.object(app_commands, "upsert_timestamp"),
            patch.object(app_commands, "info"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
        ):
            app_commands.cmd_app_domain_add(
                argparse.Namespace(app_name="shop", domain="www.shop.example.com", no_reload=False)
            )
        self.assertEqual(len(calls), 1)

    def test_access_log_enable_only_targets_nginx(self) -> None:
        import vibeops.commands.access_log_commands as access_log_commands

        db = _db_with_app()
        calls, fake_apply = self._track_apply()
        with (
            patch.object(access_log_commands, "load_db", return_value=db),
            patch.object(access_log_commands, "save_db"),
            patch.object(access_log_commands, "upsert_timestamp"),
            patch.object(access_log_commands, "info"),
            patch.object(access_log_commands, "ensure_access_log_dir"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
        ):
            access_log_commands.cmd_app_access_log(
                argparse.Namespace(access_log_action="enable", app_name="shop", no_reload=False)
            )
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].get("service_targets"), frozenset({"nginx"}))
        self.assertTrue(db["apps"]["shop"]["access_log"])
        self.assertTrue(calls[0].get("reload_services"))
        self.assertTrue(calls[0].get("validate_services"))
        self.assertEqual(set(calls[0].get("service_targets") or ()), {"nginx"})

    def test_domain_remove_and_set_main_only_target_nginx(self) -> None:
        for method, ns in (
            (
                app_commands.cmd_app_domain_remove,
                argparse.Namespace(app_name="shop", domain="www.shop.example.com", number=None, no_reload=False),
            ),
            (
                app_commands.cmd_app_domain_set_main,
                argparse.Namespace(app_name="shop", domain="www.shop.example.com", number=None, no_reload=False),
            ),
        ):
            db = _db_with_app()
            db["apps"]["shop"]["domains"] = ["shop.example.com", "www.shop.example.com"]
            db["domains"]["www.shop.example.com"] = {"kind": "php", "app": "shop"}
            calls, fake_apply = self._track_apply()
            with (
                patch.object(app_commands, "load_db", return_value=db),
                patch.object(app_commands, "save_db"),
                patch.object(app_commands, "upsert_timestamp"),
                patch.object(app_commands, "info"),
                patch("vibeops.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
            ):
                method(ns)
            self.assertEqual(len(calls), 1, msg=method.__name__)
            self.assertEqual(set(calls[0].get("service_targets") or ()), {"nginx"}, msg=method.__name__)

    def test_proxy_create_only_targets_nginx(self) -> None:
        db = _db_with_app()
        calls, fake_apply = self._track_apply()
        with (
            patch.object(proxy_commands, "load_db", return_value=db),
            patch.object(proxy_commands, "save_db"),
            patch.object(proxy_commands, "assert_domain_free"),
            patch.object(proxy_commands, "normalize_aliases", return_value=[]),
            patch.object(proxy_commands, "domains_for", return_value=["api.example.com"]),
            patch.object(proxy_commands, "upsert_timestamp"),
            patch.object(proxy_commands, "info"),
            patch.object(proxy_commands, "rel", side_effect=str),
            patch("vibeops.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
        ):
            proxy_commands.cmd_proxy_create(
                argparse.Namespace(
                    domain="api.example.com",
                    upstream="http://127.0.0.1:3000",
                    alias=None,
                    aliases=None,
                    no_reload=False,
                )
            )
        self.assertEqual(len(calls), 1)
        self.assertEqual(set(calls[0].get("service_targets") or ()), {"nginx"})

    def test_tls_commands_only_target_nginx(self) -> None:
        for method, ns in (
            (
                tls_commands.cmd_tls_acme,
                argparse.Namespace(domain="shop.example.com", off=False, no_redirect_https=False, no_reload=False),
            ),
            (
                tls_commands.cmd_tls_cert,
                argparse.Namespace(domain="shop.example.com", cert=None, key=None, no_reload=False),
            ),
        ):
            db = _db_with_app()
            calls, fake_apply = self._track_apply()
            with (
                patch.object(tls_commands, "load_db", return_value=db),
                patch.object(tls_commands, "save_db"),
                patch.object(tls_commands, "upsert_timestamp"),
                patch.object(tls_commands, "info"),
                patch.object(tls_commands, "warn"),
                patch.object(tls_commands, "rel", side_effect=str),
                patch("vibeops.commands.runtime_commands.apply_generated_config", side_effect=fake_apply),
            ):
                method(ns)
            self.assertEqual(len(calls), 1, msg=method.__name__)
            self.assertEqual(set(calls[0].get("service_targets") or ()), {"nginx"}, msg=method.__name__)

    def test_app_db_create_touches_no_web_or_php_services(self) -> None:
        db = _db_with_app()
        apply_mock = MagicMock()
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "save_db") as save_db,
            patch.object(app_commands, "ensure_mysql_database", return_value="shop_app") as ensure_db,
            patch.object(app_commands, "upsert_timestamp"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", apply_mock),
            patch.object(app_commands, "nginx_reload") as nginx_mock,
            patch("vibeops.services.php.php_reload") as php_mock,
            patch("vibeops.services.cron_runtime.cron_reload") as cron_mock,
        ):
            app_commands.cmd_app_db_create(
                argparse.Namespace(app_name="shop", db_suffix="app", mysql_service=None)
            )
        ensure_db.assert_called_once()
        save_db.assert_called_once()
        apply_mock.assert_not_called()
        nginx_mock.assert_not_called()
        php_mock.assert_not_called()
        cron_mock.assert_not_called()
        self.assertIn("shop_app", db["apps"]["shop"]["databases"])

    def test_db_create_and_user_reset_touch_no_web_or_php_services(self) -> None:
        db = _db_with_app()
        apply_mock = MagicMock()
        with (
            patch.object(db_commands, "load_db", return_value=db),
            patch.object(db_commands, "save_db"),
            patch.object(db_commands, "ensure_mysql_database", return_value="shop_reports"),
            patch.object(db_commands, "upsert_timestamp"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", apply_mock),
            patch("vibeops.services.php.php_reload") as php_mock,
            patch("vibeops.services.nginx.nginx_reload") as nginx_mock,
            patch("vibeops.services.cron_runtime.cron_reload") as cron_mock,
        ):
            db_commands.cmd_db_create(
                argparse.Namespace(app_name="shop", db_suffix="reports", mysql_service="mysql84")
            )
        apply_mock.assert_not_called()
        php_mock.assert_not_called()
        nginx_mock.assert_not_called()
        cron_mock.assert_not_called()

        db = _db_with_app()
        with (
            patch.object(db_commands, "load_db", return_value=db),
            patch.object(db_commands, "save_db"),
            patch.object(db_commands, "create_mysql_user", return_value=(True, Path("/tmp/cred"))),
            patch.object(db_commands, "apply_app_mysql_metadata"),
            patch.object(db_commands, "upsert_timestamp"),
            patch.object(db_commands, "generate_password", return_value="secret"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", apply_mock),
            patch("vibeops.services.php.php_reload") as php_mock2,
            patch("vibeops.services.nginx.nginx_reload") as nginx_mock2,
            patch("vibeops.services.cron_runtime.cron_reload") as cron_mock2,
        ):
            db_commands.cmd_db_user_reset(
                argparse.Namespace(app_name="shop", mysql_service="mysql84", password=None)
            )
        apply_mock.assert_not_called()
        php_mock2.assert_not_called()
        nginx_mock2.assert_not_called()
        cron_mock2.assert_not_called()

    def test_cron_create_reloads_only_runner_not_nginx_or_fpm(self) -> None:
        db = _db_with_app()
        lock = MagicMock()
        lock.return_value.__enter__ = MagicMock(return_value=None)
        lock.return_value.__exit__ = MagicMock(return_value=False)
        with (
            patch.object(cron_commands, "cron_state_lock", lock),
            patch.object(cron_commands, "load_db", return_value=db),
            patch.object(cron_commands, "save_db"),
            patch.object(cron_commands, "resolve_app_php_version", return_value="8.5"),
            patch.object(cron_commands, "validate_cron_workdir", return_value="/home/shop/www"),
            patch.object(cron_commands, "ensure_app", return_value=db["apps"]["shop"]),
            patch.object(cron_commands, "upsert_timestamp"),
            patch.object(cron_commands, "info"),
            patch.object(cron_commands, "rel", side_effect=str),
            patch.object(cron_commands, "stack_env", return_value={"TZ": "UTC"}),
            patch("vibeops.commands.runtime_commands.apply_generated_config") as apply_mock,
            patch("vibeops.services.php.php_reload") as php_mock,
            patch("vibeops.services.nginx.nginx_reload") as nginx_mock,
        ):
            cron_commands.cmd_cron_create(
                argparse.Namespace(
                    app_name="shop",
                    job_name="schedule",
                    schedule="* * * * *",
                    command="php artisan schedule:run",
                    workdir=None,
                    output="docker",
                    timeout=0,
                    lock=None,
                    timezone=None,
                    php=None,
                )
            )
        apply_mock.assert_called_once()
        self.assertEqual(set(apply_mock.call_args.kwargs["service_targets"]), {"runner"})
        php_mock.assert_not_called()
        nginx_mock.assert_not_called()

    def test_app_create_reloads_php_and_nginx_not_cron(self) -> None:
        db = _db_with_app()
        db["apps"].clear()
        db["domains"].clear()
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "save_db"),
            patch.object(app_commands, "resolve_app_php_version", return_value="8.5"),
            patch.object(app_commands, "resolve_app_fpm_profile", return_value="ondemand"),
            patch.object(app_commands, "assert_domain_free"),
            patch.object(
                app_commands,
                "ensure_app_identity",
                return_value={
                    "name": "blog",
                    "php_version": "8.5",
                    "domains": [],
                    "main_domain": None,
                },
            ) as identity,
            patch.object(app_commands, "mkdir"),
            patch.object(app_commands, "app_document_root", return_value=Path("/tmp/blog/www")),
            patch.object(app_commands, "apply_app_mysql_metadata"),
            patch.object(app_commands, "app_vhost_path", return_value=Path("/tmp/app-blog.conf")),
            patch.object(app_commands, "initialize_app_permissions"),
            patch.object(app_commands, "nginx_reload") as nginx_reload,
            patch.object(app_commands, "info"),
            patch.object(app_commands, "rel", side_effect=str),
            patch.object(app_commands, "upsert_timestamp"),
            patch.object(app_commands, "write_template"),
            patch("vibeops.commands.runtime_commands.apply_generated_config", return_value=[]) as apply_mock,
            patch("vibeops.services.cron_runtime.cron_reload") as cron_mock,
        ):
            app_commands.cmd_app_create(
                argparse.Namespace(
                    app_name="blog",
                    main_domain="blog.example.com",
                    db_suffix=None,
                    php="8.5",
                    mysql_service="mysql84",
                    alias=None,
                    aliases=None,
                    public_dir="",
                    php_entrypoint="auto",
                    fpm_profile=None,
                    no_index=True,
                    no_reload=False,
                    uid=None,
                    no_mysql=True,
                    mysql_password=None,
                )
            )
        identity.assert_called_once()
        # Identity path is responsible for PHP-FPM reload; apply must not reload anything.
        apply_mock.assert_called_once()
        self.assertFalse(apply_mock.call_args.kwargs.get("reload_services", True))
        nginx_reload.assert_called_once()
        cron_mock.assert_not_called()

    def test_cmd_apply_requests_full_reload_without_service_target_filter(self) -> None:
        with (
            patch.object(runtime, "load_db", return_value=_db_with_app()),
            patch.object(runtime, "save_db"),
            patch.object(runtime, "apply_generated_config", return_value=[]) as apply,
            patch.object(runtime, "info"),
        ):
            runtime.cmd_apply(argparse.Namespace(no_reload=False))
        kwargs = apply.call_args.kwargs
        self.assertTrue(kwargs.get("reload_services"))
        self.assertTrue(kwargs.get("validate_services"))
        # No service_targets means all groups (nginx + php + runner).
        self.assertIsNone(kwargs.get("service_targets"))

    def test_normalize_service_targets_defaults_to_all(self) -> None:
        self.assertEqual(runtime.normalize_service_targets(None), runtime.SERVICE_TARGETS_ALL)
        self.assertEqual(runtime.normalize_service_targets({"nginx"}), runtime.SERVICE_TARGETS_NGINX)


if __name__ == "__main__":
    unittest.main()
