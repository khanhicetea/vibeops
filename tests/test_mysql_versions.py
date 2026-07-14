from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.commands import mysql_admin_commands
from bento.commands.mysql_version_commands import cmd_mysql_add
from bento.services.mysql_versions import host_is_arm64, render_mysql_versions_compose


class MysqlVersionsTests(unittest.TestCase):
    def test_compose_renders_dedicated_service_and_durable_volume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bento-mysql-versions.yml"
            render_mysql_versions_compose({"mysql_versions": ["5.7", "8.4"]}, path, machine="x86_64")
            text = path.read_text()
            for service in ("mysql57", "mysql84"):
                self.assertIn(f"  {service}:\n", text)
                self.assertIn(f"      - {service}-data:/var/lib/mysql", text)
                self.assertIn(f"  {service}-data:\n", text)
            self.assertIn("    image: mysql:${MYSQL57_VERSION:-5.7}\n", text)
            self.assertNotIn("context: ./docker/mysql/5.7", text)

    def test_mysql_57_builds_biarms_based_custom_image_on_arm64(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bento-mysql-versions.yml"
            render_mysql_versions_compose({"mysql_versions": ["5.7", "8.4"]}, path, machine="aarch64")
            text = path.read_text()

        self.assertIn(
            "  mysql57:\n"
            "    build:\n"
            "      context: ./docker/mysql/5.7\n"
            "      dockerfile: Dockerfile\n"
            "    image: bento/mysql:5.7-arm64\n",
            text,
        )
        self.assertIn("    image: mysql:${MYSQL84_VERSION:-8.4}\n", text)
        self.assertNotIn("image: mysql:${MYSQL57_VERSION:-5.7}", text)
        self.assertNotIn("biarms-entrypoint.sh:/usr/local/bin", text)

    def test_biarms_entrypoint_prepares_bind_mounted_log_directory(self) -> None:
        entrypoint = Path("docker/mysql/5.7/biarms-entrypoint.sh").read_text()
        self.assertIn("chown -R mysql:mysql /var/log/mysql", entrypoint)
        self.assertIn('exec /usr/local/bin/docker-entrypoint.sh "$@"', entrypoint)

    def test_arm64_architecture_aliases(self) -> None:
        self.assertTrue(host_is_arm64("arm64"))
        self.assertTrue(host_is_arm64("AARCH64"))
        self.assertFalse(host_is_arm64("x86_64"))

    def test_custom_arm64_image_wraps_biarms_entrypoint(self) -> None:
        dockerfile = Path("docker/mysql/5.7/Dockerfile").read_text()
        self.assertTrue(dockerfile.startswith("FROM biarms/mysql:5.7\n"))
        self.assertIn(
            "COPY biarms-entrypoint.sh /usr/local/bin/bento-biarms-entrypoint.sh",
            dockerfile,
        )
        self.assertIn('ENTRYPOINT ["/usr/local/bin/bento-biarms-entrypoint.sh"]', dockerfile)

    def test_database_stats_formats_allocated_bytes(self) -> None:
        with (
            patch.object(
                mysql_admin_commands,
                "_mysql_tabular_rows",
                return_value=(
                    ["DATABASE_NAME", "TABLES", "SIZE_BYTES"],
                    [["shop_app", "12", "1572864"], ["empty_db", "0", "0"]],
                ),
            ),
            patch.object(mysql_admin_commands, "print_table") as table,
        ):
            mysql_admin_commands.cmd_db_stats(argparse.Namespace(mysql_service="mysql84"))

        self.assertEqual(
            table.call_args.args[0],
            [["shop_app", "12", "1.5 MiB"], ["empty_db", "0", "0 B"]],
        )
        self.assertEqual(table.call_args.kwargs["headers"], ["DATABASE", "TABLES", "SIZE"])

    def test_process_list_uses_selected_service(self) -> None:
        with (
            patch.object(
                mysql_admin_commands,
                "_mysql_tabular_rows",
                return_value=(["ID", "USER"], [["7", "shop"]]),
            ) as query,
            patch.object(mysql_admin_commands, "print_table") as table,
        ):
            mysql_admin_commands.cmd_db_process_list(argparse.Namespace(mysql_service="mysql57"))

        self.assertEqual(query.call_args.kwargs["service"], "mysql57")
        table.assert_called_once_with([["7", "shop"]], headers=["ID", "USER"])

    def test_add_persists_and_renders_without_a_remove_command(self) -> None:
        db = {"mysql_versions": ["8.4"], "apps": {}}
        with (
            patch("bento.commands.mysql_version_commands.load_db", return_value=db),
            patch("bento.commands.mysql_version_commands.render_mysql_versions_compose") as render,
            patch("bento.commands.mysql_version_commands.render_mysql_root_option_files") as render_secrets,
            patch("bento.commands.mysql_version_commands.mysql_root_option_file") as option_file,
            patch("bento.commands.mysql_version_commands.save_db") as save,
        ):
            cmd_mysql_add.__wrapped__(argparse.Namespace(version="5.7"))
        self.assertEqual(db["mysql_versions"], ["5.7", "8.4"])
        render.assert_called_once_with(db)
        render_secrets.assert_called_once_with(db=db)
        option_file.assert_called_once_with("mysql57")
        save.assert_called_once_with(db)


if __name__ == "__main__":
    unittest.main()
