#!/usr/bin/env python3
"""Entrypoint for the bento management CLI."""
from __future__ import annotations

import subprocess
import sys

from bento.utils.errors import StackError
from bento.commands.parser import build_parser


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if not argv and sys.stdin.isatty():
        argv = ["wizard"]
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.func is None:
        parser.print_help()
        return 2
    try:
        args.func(args)
        return 0
    except KeyboardInterrupt:
        # Ctrl-C during interactive prompts (wizard, confirms, shells).
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except EOFError:
        # Ctrl-D / closed stdin during interactive input.
        print("\nCancelled.", file=sys.stderr)
        return 1
    except StackError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"error: command failed ({exc.returncode}): {' '.join(exc.cmd)}", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
