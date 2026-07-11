#!/usr/bin/env python3
"""Compatibility entrypoint for the VibeOps management CLI."""
from vibeops.commands.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
