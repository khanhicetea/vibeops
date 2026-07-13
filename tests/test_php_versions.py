from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bento.commands.php_version_commands import cmd_php_remove
from bento.services.php_versions import render_php_versions_compose
from bento.utils.errors import StackError


class PhpVersionsTests(unittest.TestCase):
    def test_compose_renders_three_roles_inheriting_common_props(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bento-php-versions.yml"
            render_php_versions_compose({"php_versions": ["8.4", "8.5"]}, path)
            text = path.read_text()
            self.assertIn("x-common-php: &common-php", text)
            for service in ("php84", "php84-runner", "php84-cli", "php85", "php85-runner", "php85-cli"):
                self.assertIn(f"  {service}:\n    <<: *common-php", text)

    def test_remove_rejects_version_used_by_app(self) -> None:
        db = {"php_versions": ["8.4", "8.5"], "apps": {"shop": {"php_version": "8.4"}}}
        with (
            patch("bento.commands.php_version_commands.load_db", return_value=db),
            patch("bento.commands.php_version_commands.default_php_version", return_value="8.5"),
            self.assertRaisesRegex(StackError, "used by app.*shop"),
        ):
            cmd_php_remove.__wrapped__(argparse.Namespace(version="8.4"))


if __name__ == "__main__":
    unittest.main()
