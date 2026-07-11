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
