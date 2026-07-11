"""Template rendering and generated-file write helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from vibeops.template import render_template_text as render_vibeops_template_text

from vibeops.errors import die
from vibeops.fsutil import write_text
from vibeops.paths import GENERATED_HEADER, GENERATED_NOTICE, PHP_FPM_GENERATED_HEADER, rel

def render_template_text(text: str, values: dict[str, Any]) -> str:
    return render_vibeops_template_text(text, values)


def template_text(path: Path, values: dict[str, Any]) -> str:
    if not path.exists():
        die(f"Missing template: vibeops/{rel(path)}")
    return render_template_text(path.read_text(), values)


def generated_header_for(path: Path) -> str:
    # PHP 8.5's FPM INI parser rejects leading '#' comments in pool files.
    # Use ';' only for generated php-fpm pool fragments; keep '#' for nginx,
    # shell env, SQL, and cron files. Path-based (not live-root) so staging works.
    if path.parent.name == "pool.d" and path.suffix == ".conf":
        return PHP_FPM_GENERATED_HEADER
    return GENERATED_HEADER


def content_looks_generated(path: Path) -> bool:
    """True when a file carries the VibeOps generated notice (managed marker)."""
    try:
        head = path.read_text(errors="replace")[:400]
    except OSError:
        return False
    return GENERATED_NOTICE in head


def write_template(path: Path, template: Path, values: dict[str, Any], mode: int | None = None, *, generated: bool = False) -> None:
    content = template_text(template, values)
    if generated:
        content = generated_header_for(path) + content
    write_text(path, content, mode)


def render_template(template: Path, destination: Path, values: dict[str, Any]) -> None:
    write_template(destination, template, values, generated=True)
