"""Operational errors and console output helpers."""

from __future__ import annotations

import sys

class StackError(RuntimeError):
    pass


def info(message: str) -> None:
    print(message)


def warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr)


def die(message: str) -> None:
    raise StackError(message)


def cli_flag_present(flag: str, argv: list[str] | None = None) -> bool:
    """True if *flag* appears on argv (``--flag`` or ``--flag=value``)."""
    if argv is None:
        argv = sys.argv
    prefix = flag + "="
    return any(arg == flag or arg.startswith(prefix) for arg in argv)


def warn_password_cli_flag(flag: str = "--mysql-password") -> None:
    """Discourage passing secrets on argv (shell history / process inspection).

    Only emits when *flag* is actually present on the process argv so
    programmatic callers (e.g. the interactive wizard) are not warned.
    """
    if not cli_flag_present(flag):
        return
    warn(
        f"{flag} exposes secrets via shell history and process listings; "
        "omit the flag to auto-generate a password instead"
    )
