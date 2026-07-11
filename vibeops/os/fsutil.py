"""Filesystem write helpers for state and generated config."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from vibeops.utils.errors import warn
from vibeops.utils.paths import rel

def mkdir(path: Path, mode: int | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if mode is not None:
        try:
            path.chmod(mode)
        except PermissionError:
            warn(f"could not chmod {rel(path)}")


def write_text(path: Path, content: str, mode: int | None = None) -> None:
    mkdir(path.parent)
    path.write_text(content)
    if mode is not None:
        try:
            path.chmod(mode)
        except PermissionError:
            warn(f"could not chmod {rel(path)}")


def write_text_atomic(path: Path, content: str, mode: int = 0o644) -> None:
    """Atomically replace generated runtime config visible to containers."""
    mkdir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
