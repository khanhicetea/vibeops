"""Regression tests: database names are recorded only after successful MySQL SQL."""
from __future__ import annotations

import argparse
import copy
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import vibeops.helpers as helpers
from vibeops import app_commands


def _empty_db() -> dict:
    return {
        "schema": 1,
        "defaults": {"php_version": "8.4", "mysql_service": "mysql84"},
        "apps": {},
        "domains": {},
        "crons": {},
        "proxies": {},
        "sites": {},
        "users": {},
    }


def _app_record(app_name: str = "shop") -> dict:
    return {
        "name": app_name,
        "php_version": "8.5",
        "php_service": "php85",
        "databases": [],
        "database_services": {},
        "mysql_service": "mysql84",
    }


def _create_args(
    *,
    app_name: str = "shop",
    main_domain: str = "shop.example.com",
    db_suffix: str | None = "app",
    no_mysql: bool = False,
    mysql_service: str = "mysql84",
) -> argparse.Namespace:
    return argparse.Namespace(
        app_name=app_name,
        main_domain=main_domain,
        db_suffix=db_suffix,
        php="8.5",
        mysql_service=mysql_service,
        alias=None,
        aliases=None,
        public_dir="",
        php_entrypoint="auto",
        no_index=True,
        no_reload=True,
        uid=None,
        no_mysql=no_mysql,
        mysql_password=None,
    )


def _app_create_side_effect_patches() -> list:
    """Common cmd_app_create patches after MySQL readiness succeeds."""
    return [
        patch.object(app_commands, "require_mysql_ready_for_sql", return_value="mysql84"),
        patch.object(app_commands, "assert_domain_free"),
        patch.object(app_commands, "mkdir"),
        patch.object(app_commands, "app_document_root", return_value=Path("/tmp/home/shop/www")),
        patch.object(app_commands, "apply_app_mysql_metadata"),
        patch.object(app_commands, "render_app_vhost", return_value=Path("/tmp/app-shop.conf")),
        patch.object(app_commands, "initialize_app_permissions"),
        patch.object(app_commands, "nginx_reload"),
        patch.object(app_commands, "info"),
        patch.object(app_commands, "rel", side_effect=lambda p: str(p)),
        patch.object(app_commands, "upsert_timestamp"),
        patch.object(app_commands, "write_template"),
    ]


class EnsureMysqlDatabaseTests(unittest.TestCase):
    def test_unavailable_service_raises_before_sql(self) -> None:
        with (
            patch.object(helpers, "service_running", return_value=False),
            patch.object(helpers, "stack_env", return_value={"MYSQL84_ROOT_PASSWORD": "x"}),
            patch.object(helpers.Path, "exists", return_value=True),
            patch.object(helpers, "mysql_root_exec_sql") as sql,
        ):
            with self.assertRaisesRegex(helpers.StackError, r"not running"):
                helpers.ensure_mysql_database("shop", "app", "mysql84")
            sql.assert_not_called()

    def test_missing_root_password_raises_before_sql(self) -> None:
        with (
            patch.object(helpers, "service_running", return_value=True),
            patch.object(helpers, "stack_env", return_value={}),
            patch.object(helpers.Path, "exists", return_value=True),
            patch.object(helpers, "mysql_root_exec_sql") as sql,
        ):
            with self.assertRaisesRegex(helpers.StackError, r"root password is unset"):
                helpers.ensure_mysql_database("shop", "app", "mysql84")
            sql.assert_not_called()

    def test_missing_option_file_raises_before_sql(self) -> None:
        option = MagicMock(spec=Path)
        option.is_file.return_value = False
        with (
            patch.object(helpers, "service_running", return_value=True),
            patch.object(helpers, "stack_env", return_value={"MYSQL84_ROOT_PASSWORD": "x"}),
            patch.object(helpers.Path, "exists", return_value=True),
            patch.object(helpers, "mysql_root_option_file", return_value=option),
            patch.object(helpers, "mysql_root_exec_sql") as sql,
        ):
            with self.assertRaisesRegex(helpers.StackError, r"Missing protected MySQL option file"):
                helpers.ensure_mysql_database("shop", "app", "mysql84")
            sql.assert_not_called()

    def test_sql_failure_does_not_return_name(self) -> None:
        option = MagicMock(spec=Path)
        option.is_file.return_value = True
        with (
            patch.object(helpers, "service_running", return_value=True),
            patch.object(helpers, "stack_env", return_value={"MYSQL84_ROOT_PASSWORD": "x"}),
            patch.object(helpers.Path, "exists", return_value=True),
            patch.object(helpers, "mysql_root_option_file", return_value=option),
            patch.object(
                helpers,
                "mysql_root_exec_sql",
                side_effect=helpers.StackError("mysql on mysql84 failed (exit 1)"),
            ),
            patch.object(helpers, "template_text", return_value="CREATE DATABASE;"),
        ):
            with self.assertRaisesRegex(helpers.StackError, r"mysql on mysql84 failed"):
                helpers.ensure_mysql_database("shop", "app", "mysql84")

    def test_sql_success_returns_full_name(self) -> None:
        option = MagicMock(spec=Path)
        option.is_file.return_value = True
        with (
            patch.object(helpers, "service_running", return_value=True),
            patch.object(helpers, "stack_env", return_value={"MYSQL84_ROOT_PASSWORD": "x"}),
            patch.object(helpers.Path, "exists", return_value=True),
            patch.object(helpers, "mysql_root_option_file", return_value=option),
            patch.object(helpers, "mysql_root_exec_sql") as sql,
            patch.object(helpers, "template_text", return_value="CREATE DATABASE;"),
            patch.object(helpers, "info"),
        ):
            name = helpers.ensure_mysql_database("shop", "app", "mysql84")
            self.assertEqual(name, "shop_app")
            sql.assert_called_once()


class AppCreateDatabaseStateTests(unittest.TestCase):
    def test_unavailable_mysql_raises_before_side_effects(self) -> None:
        db = _empty_db()
        app = _app_record()
        db["apps"]["shop"] = app
        before_databases = copy.deepcopy(app.get("databases"))
        before_services = copy.deepcopy(app.get("database_services"))
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(
                app_commands,
                "require_mysql_ready_for_sql",
                side_effect=helpers.StackError(
                    "Cannot create database; mysql84 is not running, .env is missing, or root password is unset."
                ),
            ) as ready,
            patch.object(app_commands, "ensure_app_identity") as identity,
            patch.object(app_commands, "ensure_mysql_database") as ensure_db,
            patch.object(app_commands, "mysql_root_exec_sql") as sql,
            patch.object(app_commands, "save_db") as save_db,
            patch.object(app_commands, "render_app_vhost") as vhost,
            patch.object(app_commands, "write_template") as write_template,
            patch.object(app_commands, "mkdir") as mkdir,
        ):
            with self.assertRaisesRegex(helpers.StackError, r"not running"):
                app_commands.cmd_app_create(_create_args())
            ready.assert_called_once_with("mysql84")
            identity.assert_not_called()
            ensure_db.assert_not_called()
            sql.assert_not_called()
            save_db.assert_not_called()
            vhost.assert_not_called()
            write_template.assert_not_called()
            mkdir.assert_not_called()
            self.assertEqual(app.get("databases"), before_databases)
            self.assertEqual(app.get("database_services"), before_services)

    def test_missing_root_config_leaves_database_state_unchanged(self) -> None:
        db = _empty_db()
        app = _app_record()
        app["databases"] = ["shop_existing"]
        app["database_services"] = {"shop_existing": "mysql84"}
        db["apps"]["shop"] = app
        original = copy.deepcopy(app)
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(
                app_commands,
                "require_mysql_ready_for_sql",
                side_effect=helpers.StackError(
                    "Cannot create database; mysql84 is not running, .env is missing, or root password is unset."
                ),
            ),
            patch.object(app_commands, "ensure_app_identity") as identity,
            patch.object(app_commands, "ensure_mysql_database") as ensure_db,
            patch.object(app_commands, "save_db") as save_db,
        ):
            with self.assertRaises(helpers.StackError):
                app_commands.cmd_app_create(_create_args())
            identity.assert_not_called()
            ensure_db.assert_not_called()
            save_db.assert_not_called()
            self.assertEqual(app["databases"], original["databases"])
            self.assertEqual(app["database_services"], original["database_services"])

    def test_sql_failure_does_not_record_database(self) -> None:
        db = _empty_db()
        app = _app_record()
        db["apps"]["shop"] = app
        original_db_keys = copy.deepcopy(
            {"databases": app["databases"], "database_services": app["database_services"]}
        )
        with ExitStack() as stack:
            stack.enter_context(patch.object(app_commands, "load_db", return_value=db))
            stack.enter_context(patch.object(app_commands, "ensure_app_identity", return_value=app))
            stack.enter_context(
                patch.object(
                    app_commands,
                    "ensure_mysql_database",
                    side_effect=helpers.StackError("mysql on mysql84 failed (exit 1)"),
                )
            )
            save_db = stack.enter_context(patch.object(app_commands, "save_db"))
            for p in _app_create_side_effect_patches():
                stack.enter_context(p)
            with self.assertRaisesRegex(helpers.StackError, r"mysql on mysql84 failed"):
                app_commands.cmd_app_create(_create_args())
            save_db.assert_not_called()
            self.assertEqual(app["databases"], original_db_keys["databases"])
            self.assertEqual(app["database_services"], original_db_keys["database_services"])

    def test_sql_success_records_exactly_one_database_and_service(self) -> None:
        db = _empty_db()
        app = _app_record()
        db["apps"]["shop"] = app
        with ExitStack() as stack:
            stack.enter_context(patch.object(app_commands, "load_db", return_value=db))
            stack.enter_context(patch.object(app_commands, "ensure_app_identity", return_value=app))
            ensure_db = stack.enter_context(
                patch.object(app_commands, "ensure_mysql_database", return_value="shop_app")
            )
            save_db = stack.enter_context(patch.object(app_commands, "save_db"))
            for p in _app_create_side_effect_patches():
                stack.enter_context(p)
            app_commands.cmd_app_create(_create_args())
            ensure_db.assert_called_once_with("shop", "app", "mysql84")
            save_db.assert_called_once_with(db)
            self.assertEqual(app["databases"], ["shop_app"])
            self.assertEqual(app["database_services"], {"shop_app": "mysql84"})

    def test_successful_creation_is_idempotent_in_state(self) -> None:
        db = _empty_db()
        app = _app_record()
        app["databases"] = ["shop_app"]
        app["database_services"] = {"shop_app": "mysql84"}
        db["apps"]["shop"] = app
        with ExitStack() as stack:
            stack.enter_context(patch.object(app_commands, "load_db", return_value=db))
            stack.enter_context(patch.object(app_commands, "ensure_app_identity", return_value=app))
            stack.enter_context(
                patch.object(app_commands, "ensure_mysql_database", return_value="shop_app")
            )
            stack.enter_context(patch.object(app_commands, "save_db"))
            for p in _app_create_side_effect_patches():
                stack.enter_context(p)
            app_commands.cmd_app_create(_create_args())
            self.assertEqual(app["databases"], ["shop_app"])
            self.assertEqual(app["database_services"], {"shop_app": "mysql84"})

    def test_without_suffix_retains_best_effort_mysql_account(self) -> None:
        db = _empty_db()
        app = _app_record()
        db["apps"]["shop"] = app
        with ExitStack() as stack:
            stack.enter_context(patch.object(app_commands, "load_db", return_value=db))
            identity = stack.enter_context(
                patch.object(app_commands, "ensure_app_identity", return_value=app)
            )
            ready = stack.enter_context(patch.object(app_commands, "require_mysql_ready_for_sql"))
            ensure_db = stack.enter_context(patch.object(app_commands, "ensure_mysql_database"))
            save_db = stack.enter_context(patch.object(app_commands, "save_db"))
            for p in _app_create_side_effect_patches():
                # Skip the default require_mysql_ready_for_sql patch from the helper list.
                if getattr(p, "attribute", None) == "require_mysql_ready_for_sql":
                    continue
                stack.enter_context(p)
            app_commands.cmd_app_create(_create_args(db_suffix=None, no_mysql=False))
            ready.assert_not_called()
            ensure_db.assert_not_called()
            identity.assert_called_once()
            self.assertFalse(identity.call_args.kwargs.get("no_mysql"))
            save_db.assert_called_once()
            self.assertEqual(app["databases"], [])
            self.assertEqual(app["database_services"], {})

    def test_no_mysql_cannot_combine_with_suffix(self) -> None:
        db = _empty_db()
        with (
            patch.object(app_commands, "load_db", return_value=db),
            patch.object(app_commands, "ensure_app_identity") as identity,
            patch.object(app_commands, "ensure_mysql_database") as ensure_db,
            patch.object(app_commands, "save_db") as save_db,
        ):
            with self.assertRaisesRegex(
                helpers.StackError, r"Cannot create a database suffix with --no-mysql"
            ):
                app_commands.cmd_app_create(_create_args(no_mysql=True))
            identity.assert_not_called()
            ensure_db.assert_not_called()
            save_db.assert_not_called()


if __name__ == "__main__":
    unittest.main()
