#!/usr/bin/env python3
"""Compatibility entrypoint for the bento management CLI."""
from bento.commands.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
