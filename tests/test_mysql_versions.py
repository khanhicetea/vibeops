from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.commands.mysql_version_commands import cmd_mysql_add
from bento.services.mysql_versions import render_mysql_versions_compose


class MysqlVersionsTests(unittest.TestCase):
    def test_compose_renders_dedicated_service_and_durable_volume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bento-mysql-versions.yml"
            render_mysql_versions_compose({"mysql_versions": ["5.7", "8.4"]}, path)
            text = path.read_text()
            for service in ("mysql57", "mysql84"):
                self.assertIn(f"  {service}:\n", text)
                self.assertIn(f"      - {service}-data:/var/lib/mysql", text)
                self.assertIn(f"  {service}-data:\n", text)

    def test_add_persists_and_renders_without_a_remove_command(self) -> None:
        db = {"mysql_versions": ["8.4"], "apps": {}}
        with (
            patch("bento.commands.mysql_version_commands.load_db", return_value=db),
            patch("bento.commands.mysql_version_commands.render_mysql_versions_compose") as render,
            patch("bento.commands.mysql_version_commands.save_db") as save,
        ):
            cmd_mysql_add.__wrapped__(argparse.Namespace(version="5.7"))
        self.assertEqual(db["mysql_versions"], ["5.7", "8.4"])
        render.assert_called_once_with(db)
        save.assert_called_once_with(db)


if __name__ == "__main__":
    unittest.main()
