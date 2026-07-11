"""Source and package layout invariants for the decomposed vibeops package."""
from __future__ import annotations

import ast
import importlib
import pkgutil
import re
import unittest
from pathlib import Path

import vibeops
from vibeops.parser import build_parser

ROOT = Path(__file__).resolve().parents[1]
VIBEOPS = ROOT / "vibeops"
TESTS = ROOT / "tests"

FOUNDATIONAL = {
    "errors",
    "paths",
    "validation",
    "env",
    "fsutil",
    "process",
    "state",
    "rendering",
    "mysql",
    "php",
    "nginx",
    "cron_runtime",
    "compose",
    "template",
}

COMMAND_LAYER = {
    "app_commands",
    "cron_commands",
    "db_commands",
    "permission_commands",
    "proxy_commands",
    "runtime_commands",
    "tls_commands",
    "wizard_commands",
    "parser",
    "cli",
}


def _py_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.py") if "__pycache__" not in p.parts)


class WildcardImportInvariantTests(unittest.TestCase):
    def test_no_wildcard_imports_in_package_or_tests(self) -> None:
        pattern = re.compile(r"^\s*from\s+\S+\s+import\s+\*|^\s*import\s+\S+\s+\*")
        offenders: list[str] = []
        for path in _py_files(VIBEOPS) + _py_files(TESTS):
            for i, line in enumerate(path.read_text().splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{path.relative_to(ROOT)}:{i}:{line.strip()}")
        self.assertEqual(offenders, [], msg="wildcard imports forbidden:\n" + "\n".join(offenders))


class LayerImportInvariantTests(unittest.TestCase):
    def test_foundational_modules_do_not_import_command_layer(self) -> None:
        forbidden = COMMAND_LAYER | {"helpers"}
        bad: list[str] = []
        for name in sorted(FOUNDATIONAL):
            path = VIBEOPS / f"{name}.py"
            if not path.exists():
                continue
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in tree.body:
                if not isinstance(node, ast.ImportFrom) or not node.module:
                    continue
                if not node.module.startswith("vibeops"):
                    continue
                target = node.module.split(".", 1)[-1] if "." in node.module else node.module
                # also handle from vibeops import x
                if node.module == "vibeops":
                    for alias in node.names:
                        if alias.name in forbidden:
                            bad.append(f"{name} imports vibeops.{alias.name}")
                elif target in forbidden:
                    bad.append(f"{name} imports {node.module}")
            # scan function bodies for lazy imports of command layer
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("vibeops."):
                    target = node.module.split(".", 1)[-1]
                    if target in COMMAND_LAYER:
                        # only allow if not at module top already counted; lazy in body of foundational is still bad
                        bad.append(f"{name} references command layer {node.module}")
        # Deduplicate while preserving order
        seen: set[str] = set()
        uniq = []
        for item in bad:
            if item not in seen:
                seen.add(item)
                uniq.append(item)
        self.assertEqual(uniq, [], msg="layer violations:\n" + "\n".join(uniq))


class ImportAllModulesSmokeTests(unittest.TestCase):
    def test_import_all_vibeops_modules(self) -> None:
        for module in pkgutil.iter_modules(vibeops.__path__):
            if module.name == "__main__":
                continue
            with self.subTest(module=module.name):
                importlib.import_module(f"vibeops.{module.name}")


class ParserCallbackInvariantTests(unittest.TestCase):
    def test_every_subparser_callback_is_callable(self) -> None:
        parser = build_parser()
        callables: list[str] = []

        def walk(p, prefix: str = "") -> None:
            for action in getattr(p, "_actions", []):
                if action.dest == "help":
                    continue
                choices = getattr(action, "choices", None)
                if isinstance(choices, dict):
                    for name, sub in choices.items():
                        walk(sub, f"{prefix}{name}.")
                defaults = getattr(p, "_defaults", {}) or {}
                func = defaults.get("func")
                if func is not None:
                    callables.append(prefix.rstrip(".") or "(root)")
                    self.assertTrue(callable(func), msg=f"{prefix} func is not callable: {func!r}")

        walk(parser)
        # Ensure we found real command callbacks (not only the empty root default).
        self.assertGreaterEqual(len([c for c in callables if c != "(root)"]), 20)

    def test_build_parser_smoke(self) -> None:
        parser = build_parser()
        help_text = parser.format_help()
        for name in ("app", "render", "compose", "status", "db", "cron"):
            self.assertIn(name, help_text)


class ModuleSizeWarningTests(unittest.TestCase):
    """Track oversized modules; warn in message but allow known large files."""

    KNOWN_LARGE = {
        "runtime_commands.py": 900,  # render/apply transaction orchestration
        "wizard_commands.py": 550,
        "db_commands.py": 550,
        "app_commands.py": 400,
        "parser.py": 350,
    }

    def test_module_sizes_within_review_threshold(self) -> None:
        over: list[str] = []
        for path in sorted(VIBEOPS.glob("*.py")):
            lines = len(path.read_text().splitlines())
            limit = self.KNOWN_LARGE.get(path.name, 400)
            if lines > limit:
                over.append(f"{path.name}: {lines} lines > {limit}")
        self.assertEqual(over, [], msg="modules exceed review threshold:\n" + "\n".join(over))


if __name__ == "__main__":
    unittest.main()
