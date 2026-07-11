"""Deprecated compatibility re-exports for VibeOps helpers.

Prefer focused modules such as ``vibeops.state``, ``vibeops.php``, and
``vibeops.mysql``. This shim exists only for transitional imports and will
be removed once remaining call sites migrate.
"""
from __future__ import annotations

from importlib import import_module
from typing import Any

# Owning modules for transitional attribute lookup. Keep this list in sync with
# the package layout; do not add business logic here.
_OWNER_MODULES = (
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
)

_cache: dict[str, str] | None = None


def _export_map() -> dict[str, str]:
    global _cache
    if _cache is not None:
        return _cache
    mapping: dict[str, str] = {}
    for mod_name in _OWNER_MODULES:
        mod = import_module(f"vibeops.{mod_name}")
        for name in getattr(mod, "__all__", None) or dir(mod):
            if name.startswith("_"):
                continue
            if name in mapping:
                continue
            # Prefer names actually defined on the module (not re-exports of imports).
            if name not in getattr(mod, "__dict__", {}):
                continue
            mapping[name] = mod_name
    _cache = mapping
    return mapping


def __getattr__(name: str) -> Any:
    mod_name = _export_map().get(name)
    if mod_name is None:
        raise AttributeError(f"module 'vibeops.helpers' has no attribute {name!r}")
    value = getattr(import_module(f"vibeops.{mod_name}"), name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(_export_map()))
