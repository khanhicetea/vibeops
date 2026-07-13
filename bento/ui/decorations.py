"""Small, dependency-free presentation helpers for the interactive CLI."""
from __future__ import annotations

import shutil
from collections.abc import Callable, Iterable

from bento.utils.errors import info


def left_pad(text: object, spaces: int = 2) -> str:
    """Indent every line in *text*, including blank lines."""
    if spaces < 0:
        raise ValueError("spaces must be non-negative")
    prefix = " " * spaces
    return "\n".join(prefix + line for line in str(text).split("\n"))


def format_heading(title: object, *, marker: str = "=") -> list[str]:
    """Return a compact section heading made only from portable ASCII."""
    text = str(title).strip()
    decorated = f"{marker * 3} {text} {marker * 3}" if text else marker * 7
    return [decorated]


def print_heading(
    title: object,
    *,
    marker: str = "=",
    leading_blank: bool = True,
    writer: Callable[[str], None] = info,
) -> None:
    """Print a section heading through the selected console writer."""
    if leading_blank:
        writer("")
    for line in format_heading(title, marker=marker):
        writer(line)


def format_list(items: Iterable[object], *, indent: int = 2, bullet: str = "-") -> list[str]:
    """Format items as an indented list, aligning wrapped item lines."""
    lines: list[str] = []
    item_prefix = " " * indent + bullet + " "
    continuation = " " * len(item_prefix)
    for item in items:
        parts = str(item).splitlines() or [""]
        lines.append(item_prefix + parts[0])
        lines.extend(continuation + part for part in parts[1:])
    return lines


def print_list(
    items: Iterable[object],
    *,
    indent: int = 2,
    bullet: str = "-",
    writer: Callable[[str], None] = info,
) -> None:
    for line in format_list(items, indent=indent, bullet=bullet):
        writer(line)


def format_bottom_border(*, width: int | None = None, indent: int = 0) -> str:
    """Return a portable ASCII line for separating command screens."""
    if indent < 0:
        raise ValueError("indent must be non-negative")
    columns = width if width is not None else shutil.get_terminal_size(fallback=(80, 24)).columns
    line_width = max(1, min(70, columns - indent))
    return " " * indent + "-" * line_width


def print_bottom_border(
    *,
    width: int | None = None,
    indent: int = 0,
    writer: Callable[[str], None] = info,
) -> None:
    writer(format_bottom_border(width=width, indent=indent))


def format_menu(
    label: object,
    entries: Iterable[tuple[int, object]],
    *,
    indent: int = 2,
    selected_number: int | None = None,
    bottom_border: bool = True,
    width: int | None = None,
) -> list[str]:
    """Format a numbered menu, optionally marking one selected entry."""
    lines = [f"{label}:"]
    pad = " " * indent
    for number, text in entries:
        cursor = ""
        if selected_number is not None:
            cursor = "> " if number == selected_number else "  "
        lines.append(f"{pad}{cursor}{number} - {text}")
    if bottom_border:
        lines.append(format_bottom_border(width=width))
    return lines


_ALERT_MARKERS = {
    "info": "i",
    "success": "+",
    "warning": "!",
    "error": "x",
}


def format_alert(message: object, *, kind: str = "info") -> list[str]:
    """Format a multi-line alert with a short, greppable severity marker."""
    if kind not in _ALERT_MARKERS:
        raise ValueError(f"unknown alert kind: {kind}")
    prefix = f"[{_ALERT_MARKERS[kind]}] "
    continuation = " " * len(prefix)
    parts = str(message).splitlines() or [""]
    return [prefix + parts[0], *(continuation + part for part in parts[1:])]


def print_alert(
    message: object,
    *,
    kind: str = "info",
    writer: Callable[[str], None] = info,
) -> None:
    for line in format_alert(message, kind=kind):
        writer(line)
