"""Terminal-width-aware table formatting for CLI listings."""
from __future__ import annotations

import shutil
from collections.abc import Sequence
from typing import Any

from vibeops.errors import info

# Conservative default when stdout is not a TTY (pipes, CI, captures).
_DEFAULT_WIDTH = 80
_MIN_WIDTH = 40
_COL_SEP = "  "
_ELLIPSIS = "…"


def terminal_width(*, fallback: int = _DEFAULT_WIDTH) -> int:
    """Return the current terminal width via ``shutil.get_terminal_size()``.

    Falls back to *fallback* when the size cannot be detected (non-TTY, etc.).
    Clamped so tables never assume an absurdly narrow or wide display.
    """
    columns = shutil.get_terminal_size(fallback=(fallback, 24)).columns
    return max(_MIN_WIDTH, columns)


def truncate_cell(text: str, width: int) -> str:
    """Fit *text* into *width* columns, appending an ellipsis when truncated."""
    if width <= 0:
        return ""
    if len(text) <= width:
        return text
    if width == 1:
        return _ELLIPSIS
    return text[: width - 1] + _ELLIPSIS


def _cell_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\t", " ").replace("\n", " ").replace("\r", "")


def _natural_widths(
    headers: Sequence[str] | None,
    rows: Sequence[Sequence[str]],
    ncols: int,
) -> list[int]:
    widths = [0] * ncols
    if headers:
        for i, h in enumerate(headers):
            widths[i] = max(widths[i], len(h))
    for row in rows:
        for i in range(ncols):
            cell = row[i] if i < len(row) else ""
            widths[i] = max(widths[i], len(cell))
    return widths


def _fit_widths(natural: list[int], available: int, *, min_col: int = 3) -> list[int]:
    """Shrink column widths so ``sum(widths) <= available``, preferring larger columns."""
    if available <= 0:
        return [1] * len(natural)
    widths = [max(1, w) for w in natural]
    mins = [min(min_col, w) for w in widths]
    # If even mins exceed available, allow shrinking below min_col.
    if sum(mins) > available:
        mins = [1] * len(widths)
    total = sum(widths)
    while total > available:
        over = [i for i in range(len(widths)) if widths[i] > mins[i]]
        if not over:
            break
        i = max(over, key=lambda idx: widths[idx])
        widths[i] -= 1
        total -= 1
    return widths


def format_table(
    rows: Sequence[Sequence[Any]],
    headers: Sequence[str] | None = None,
    *,
    width: int | None = None,
    sep: str = _COL_SEP,
    show_header: bool = True,
) -> list[str]:
    """Format *rows* as aligned columns that fit the terminal width.

    Returns a list of lines (no trailing newlines). When *headers* is given and
    *show_header* is true, a header row and a dashed rule are included.
    """
    str_rows = [[_cell_str(c) for c in row] for row in rows]
    header_cells = [_cell_str(h) for h in headers] if headers else None

    ncols = 0
    if header_cells:
        ncols = max(ncols, len(header_cells))
    for row in str_rows:
        ncols = max(ncols, len(row))
    if ncols == 0:
        return []

    # Pad short rows.
    str_rows = [row + [""] * (ncols - len(row)) for row in str_rows]
    if header_cells is not None and len(header_cells) < ncols:
        header_cells = header_cells + [""] * (ncols - len(header_cells))

    term_width = width if width is not None else terminal_width()
    sep_len = len(sep) * (ncols - 1)
    available = max(ncols, term_width - sep_len)

    natural = _natural_widths(header_cells, str_rows, ncols)
    col_widths = _fit_widths(natural, available)

    lines: list[str] = []
    if header_cells is not None and show_header:
        cells = [truncate_cell(header_cells[i], col_widths[i]).ljust(col_widths[i]) for i in range(ncols)]
        lines.append(sep.join(cells).rstrip())
        rule = sep.join(("-" * col_widths[i]) for i in range(ncols))
        lines.append(rule[:term_width].rstrip() if term_width else rule.rstrip())

    for row in str_rows:
        cells = [truncate_cell(row[i], col_widths[i]).ljust(col_widths[i]) for i in range(ncols)]
        lines.append(sep.join(cells).rstrip())
    return lines


def print_table(
    rows: Sequence[Sequence[Any]],
    headers: Sequence[str] | None = None,
    *,
    width: int | None = None,
    sep: str = _COL_SEP,
    show_header: bool = True,
    prefix: str = "",
) -> None:
    """Print a terminal-width-aware table via :func:`info`."""
    for line in format_table(rows, headers=headers, width=width, sep=sep, show_header=show_header):
        info(f"{prefix}{line}" if prefix else line)
