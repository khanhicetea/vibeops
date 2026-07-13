from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bento.services.compose import compose_files, compose_prefix
from bento.utils.errors import StackError


class ComposeFilesTests(unittest.TestCase):
    def test_loads_core_and_all_local_fragments_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "config").mkdir()
            (root / "config" / "compose.yml").write_text("services: {}\n")
            (root / "compose.override.yml").write_text("services: {}\n")
            (root / "compose.local.yml").write_text("services: {}\n")
            (root / "compose.d").mkdir()
            (root / "compose.d" / "20-tunnel.yaml").write_text("services: {}\n")
            (root / "compose.d" / "10-php.yml").write_text("services: {}\n")

            self.assertEqual(
                [path.relative_to(root).as_posix() for path in compose_files(root)],
                [
                    "config/compose.yml",
                    "compose.override.yml",
                    "compose.local.yml",
                    "compose.d/10-php.yml",
                    "compose.d/20-tunnel.yaml",
                ],
            )
            self.assertEqual(compose_prefix(root)[:4], ["docker", "compose", "--project-directory", str(root.resolve())])

    def test_requires_core_compose_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(StackError, "config/compose.yml"):
                compose_files(Path(tmp))


if __name__ == "__main__":
    unittest.main()
