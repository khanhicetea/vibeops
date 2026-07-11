"""Source and package layout invariants for the decomposed vibeops package."""
from __future__ import annotations

import ast
import importlib
import pkgutil
import re
import unittest
from pathlib import Path

import vibeops
from vibeops.commands.parser import build_parser

ROOT = Path(__file__).resolve().parents[1]
VIBEOPS = ROOT / "vibeops"
TESTS = ROOT / "tests"

# Leaf module name -> relative path under vibeops/
FOUNDATIONAL = {
    "errors": "utils/errors.py",
    "paths": "utils/paths.py",
    "validation": "utils/validation.py",
    "env": "utils/env.py",
    "template": "utils/template.py",
    "fsutil": "os/fsutil.py",
    "process": "os/process.py",
    "compose": "services/compose.py",
    "app_config": "services/app_config.py",
    "state": "services/state.py",
    "rendering": "services/rendering.py",
    "mysql": "services/mysql.py",
    "php": "services/php.py",
    "nginx": "services/nginx.py",
    "access_log": "services/access_log.py",
    "cron_runtime": "services/cron_runtime.py",
    "table": "ui/table.py",
}

COMMAND_LAYER = {
    "access_log_commands",
    "app_commands",
    "app_config_commands",
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

COMMAND_LAYER_PREFIXES = (
    "vibeops.commands.",
)


def _py_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*.py") if "__pycache__" not in p.parts)


def _import_targets(module: str | None, names: list[ast.alias] | None = None) -> list[str]:
    """Return leaf module names referenced by an ImportFrom of vibeops.*."""
    if not module:
        return []
    if module == "vibeops":
        return [alias.name for alias in (names or [])]
    if not module.startswith("vibeops."):
        return []
    # vibeops.commands.app_commands -> app_commands
    # vibeops.utils.errors -> errors
    return [module.rsplit(".", 1)[-1]]


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
        for name, rel in sorted(FOUNDATIONAL.items()):
            path = VIBEOPS / rel
            if not path.exists():
                bad.append(f"missing foundational module: {rel}")
                continue
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or not node.module:
                    continue
                if not node.module.startswith("vibeops"):
                    continue
                if any(node.module.startswith(p) or node.module == p.rstrip(".") for p in COMMAND_LAYER_PREFIXES):
                    # any import from vibeops.commands is forbidden in foundational
                    bad.append(f"{name} imports command layer {node.module}")
                    continue
                for target in _import_targets(node.module, node.names):
                    if target in forbidden:
                        bad.append(f"{name} imports vibeops...{target} via {node.module}")
        seen: set[str] = set()
        uniq = []
        for item in bad:
            if item not in seen:
                seen.add(item)
                uniq.append(item)
        self.assertEqual(uniq, [], msg="layer violations:\n" + "\n".join(uniq))


class ImportAllModulesSmokeTests(unittest.TestCase):
    def test_import_all_vibeops_modules(self) -> None:
        """Import every submodule under vibeops (including nested packages)."""

        def walk(package_name: str, package_path: list[str]) -> None:
            for module in pkgutil.iter_modules(package_path):
                full = f"{package_name}.{module.name}"
                if module.name == "__main__":
                    continue
                with self.subTest(module=full):
                    imported = importlib.import_module(full)
                    if module.ispkg and getattr(imported, "__path__", None):
                        walk(full, list(imported.__path__))

        walk("vibeops", list(vibeops.__path__))


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
        "runtime_commands.py": 1150,  # render/apply transaction orchestration
        "wizard_commands.py": 550,
        "db_commands.py": 550,
        "app_commands.py": 400,
        "parser.py": 400,
    }

    def test_module_sizes_within_review_threshold(self) -> None:
        over: list[str] = []
        for path in sorted(_py_files(VIBEOPS)):
            if path.name == "__init__.py":
                continue
            lines = len(path.read_text().splitlines())
            limit = self.KNOWN_LARGE.get(path.name, 400)
            if lines > limit:
                over.append(f"{path.relative_to(VIBEOPS)}: {lines} lines > {limit}")
        self.assertEqual(over, [], msg="modules exceed review threshold:\n" + "\n".join(over))


class PackageLayoutTests(unittest.TestCase):
    def test_expected_subpackages_exist(self) -> None:
        for name in ("utils", "os", "services", "ui", "commands"):
            self.assertTrue((VIBEOPS / name / "__init__.py").is_file(), msg=f"missing {name}/")

    def test_foundational_files_live_under_subpackages(self) -> None:
        for rel in FOUNDATIONAL.values():
            self.assertTrue((VIBEOPS / rel).is_file(), msg=f"missing {rel}")
        # No leftover flat modules that should have been moved
        for leaf in FOUNDATIONAL:
            self.assertFalse((VIBEOPS / f"{leaf}.py").exists(), msg=f"flat leftover vibeops/{leaf}.py")


if __name__ == "__main__":
    unittest.main()
