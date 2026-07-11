"""Docker Compose argv builder for VibeOps local overlay context.

All internal Compose invocations should use ``compose_command`` so
``compose.local.yml`` and ``compose.d/*`` overlays apply consistently.
"""
from __future__ import annotations

from pathlib import Path

from vibeops.utils.errors import StackError
from vibeops.utils.paths import ROOT


def compose_files(root: Path = ROOT) -> list[Path]:
    """Return Compose files in load order: base, optional overlays, then compose.d.

    ``compose.d`` entries are sorted by basename (mixed ``.yml`` / ``.yaml``).
    Duplicate paths (including symlink aliases of already-listed files) are skipped.
    """
    root = Path(root)
    base = root / "compose.yml"
    if not base.is_file():
        raise StackError(f"Missing compose.yml under {root}")

    files: list[Path] = [base]
    seen: set[Path] = {base.resolve()}

    for name in ("compose.override.yml", "compose.local.yml"):
        path = root / name
        if not path.exists():
            continue
        resolved = path.resolve()
        if resolved in seen:
            continue
        files.append(path)
        seen.add(resolved)

    compose_d = root / "compose.d"
    if compose_d.is_dir():
        extras = [p for p in compose_d.iterdir() if p.is_file() and p.suffix in {".yml", ".yaml"}]
        extras.sort(key=lambda p: p.name)
        for path in extras:
            resolved = path.resolve()
            if resolved in seen:
                continue
            files.append(path)
            seen.add(resolved)

    return files


def _file_arg(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path(root).resolve()))
    except ValueError:
        return str(path.resolve())


def compose_prefix(root: Path = ROOT) -> list[str]:
    """Return ``['docker', 'compose', '-f', ...]`` for the overlay context."""
    prefix = ["docker", "compose"]
    for path in compose_files(root):
        prefix.extend(["-f", _file_arg(path, root)])
    return prefix


def compose_command(*args: str, root: Path = ROOT) -> list[str]:
    """Build a full Docker Compose argv list with the local overlay context."""
    return [*compose_prefix(root), *args]
