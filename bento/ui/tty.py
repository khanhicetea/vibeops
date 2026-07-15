"""Numbered and interactive TTY menus for the management CLI."""
from __future__ import annotations

import sys

from bento.ui.decorations import format_bottom_border, format_menu, left_pad
from bento.utils.errors import info, warn


def interactive_menu_available() -> bool:
    """Return whether stdin/stdout support the Unix cbreak menu."""
    if not (
        sys.stdin.isatty()
        and sys.stdout.isatty()
        and sys.stdin.fileno() >= 0
    ):
        return False
    try:
        import termios  # noqa: F401 — availability probe for non-Unix hosts
        import tty  # noqa: F401
    except ImportError:
        return False
    return True


def _choice_entries(
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> list[tuple[str, int, str]]:
    """Build (return_value, number, label) rows for a choice menu."""
    entries: list[tuple[str, int, str]] = []
    if zero is not None:
        entries.append((zero, 0, zero))
    for idx, choice in enumerate(choices, start=1):
        marker = " *" if choice == default else ""
        entries.append((choice, idx, f"{choice}{marker}"))
    return entries


def _resolve_choice_number(
    idx: int,
    choices: list[str],
    zero: str | None,
) -> str | None:
    if zero is not None and idx == 0:
        return zero
    if 1 <= idx <= len(choices):
        return choices[idx - 1]
    return None


def prompt_choice_numbered(
    label: str,
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> str:
    """Line-oriented number prompt (pipes, tests, non-TTY)."""
    entries = _choice_entries(choices, default, zero)
    for line in format_menu(label, [(num, text) for _value, num, text in entries]):
        info(line)
    lo = 0 if zero is not None else 1
    while True:
        raw = input(
            f"Choose {lo}-{len(choices)}"
            + (f" [{default}]" if default else "")
            + ": "
        ).strip()
        if not raw and default:
            return default
        try:
            idx = int(raw)
        except ValueError:
            idx = -1
        resolved = _resolve_choice_number(idx, choices, zero)
        if resolved is not None:
            return resolved
        warn("invalid selection")


def _is_csi_final(ch: str) -> bool:
    """True for a CSI final byte (0x40–0x7E, i.e. '@' through '~')."""
    return len(ch) == 1 and "@" <= ch <= "~"


def _read_menu_key() -> str:
    """Read one key in cbreak mode and normalize menu control keys."""
    ch = sys.stdin.read(1)
    if not ch:
        raise EOFError
    if ch == "\x1b":
        # ANSI escape: arrows are ESC [ A/B/C/D (and ESC O A/B on some terminals).
        rest = sys.stdin.read(1)
        if rest == "[":
            code = sys.stdin.read(1)
            if code == "A":
                return "up"
            if code == "B":
                return "down"
            if code in ("C", "D"):
                # Left/right: ignore (do not hang waiting for more CSI bytes).
                return "esc"
            # Consume remaining intermediate CSI params until a final byte.
            while code and not _is_csi_final(code):
                code = sys.stdin.read(1)
            return "esc"
        if rest == "O":
            code = sys.stdin.read(1)
            if code == "A":
                return "up"
            if code == "B":
                return "down"
            return "esc"
        return "esc"
    if ch in ("\r", "\n"):
        return "enter"
    if ch in ("\x7f", "\b"):
        return "backspace"
    if ch == "\x03":
        raise KeyboardInterrupt
    if ch == "\x04":
        raise EOFError
    return ch


def prompt_choice_interactive(
    label: str,
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> str:
    """TTY menu: ↑/↓ + Enter to select; digits remain a fallback."""
    import termios
    import tty as tty_module

    entries = _choice_entries(choices, default, zero)
    lo = 0 if zero is not None else 1
    hi = len(choices)
    # Highlight default choice when present; otherwise first real option (or 0 if only zero).
    selected = 0
    if default is not None:
        for i, (value, _num, _text) in enumerate(entries):
            if value == default:
                selected = i
                break
    elif zero is not None and len(entries) > 1:
        selected = 1
    digit_buf = ""
    instant_digits = hi <= 9
    hint = f"↑↓ move · Enter select · or type {lo}-{hi}"
    if instant_digits:
        hint += " (digit selects)"
    body_lines = 1 + len(entries) + 2  # label + options + hint + bottom border
    first_draw = True

    def draw() -> None:
        nonlocal first_draw
        lines = format_menu(
            label,
            [(num, text) for _value, num, text in entries],
            selected_number=entries[selected][1],
            bottom_border=False,
        )
        status = hint
        if digit_buf:
            status = f"number: {digit_buf}_  · Enter confirm · Backspace edit"
        lines.append(left_pad(status))
        lines.append(format_bottom_border())
        if not first_draw:
            sys.stdout.write(f"\033[{body_lines}A")
        for line in lines:
            sys.stdout.write(f"\033[2K\r{line}\n")
        sys.stdout.flush()
        first_draw = False

    fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(fd)
    # Hide cursor while the menu is active.
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()
    try:
        tty_module.setcbreak(fd)
        draw()
        while True:
            key = _read_menu_key()
            if key == "up":
                digit_buf = ""
                selected = (selected - 1) % len(entries)
                draw()
            elif key == "down":
                digit_buf = ""
                selected = (selected + 1) % len(entries)
                draw()
            elif key == "enter":
                if digit_buf:
                    try:
                        idx = int(digit_buf)
                    except ValueError:
                        idx = -1
                    resolved = _resolve_choice_number(idx, choices, zero)
                    if resolved is not None:
                        return resolved
                    digit_buf = ""
                    draw()
                    continue
                return entries[selected][0]
            elif key == "backspace":
                if digit_buf:
                    digit_buf = digit_buf[:-1]
                    draw()
            elif key.isdigit():
                if instant_digits:
                    resolved = _resolve_choice_number(int(key), choices, zero)
                    if resolved is not None:
                        return resolved
                    continue
                digit_buf += key
                # Snap highlight when the buffer is a complete valid number.
                try:
                    idx = int(digit_buf)
                except ValueError:
                    idx = -1
                for i, (_value, num, _text) in enumerate(entries):
                    if num == idx:
                        selected = i
                        break
                draw()
            # Ignore other keys (letters, esc leftovers, etc.).
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()
