"""Regex patterns and pure validators for CLI and state values."""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from bento.utils.errors import die

APP_NAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")

DOMAIN_RE = re.compile(r"^[A-Za-z0-9.-]+$")

DOMAIN_PATH_RE = re.compile(r"^[A-Za-z0-9._-]+$")

PHP_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+$")

MYSQL_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+$")

DB_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")

DATABASE_RE = re.compile(r"^[A-Za-z0-9_-]+$")

PUBLIC_DIR_RE = re.compile(r"^[A-Za-z0-9._/-]*$")

PHP_ENTRYPOINTS = {"front-controller", "legacy"}

MYSQL_SERVICE_RE = re.compile(r"^mysql[0-9]+$")

JOB_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

CRON_LOCK_RE = JOB_RE


def validate(value: str, pattern: re.Pattern[str], label: str) -> str:
    if not value or not pattern.match(value):
        die(f"Invalid {label}: {value}")
    return value


def validate_cron_workdir(app_name: str, workdir: str) -> str:
    root = PurePosixPath("/home") / app_name
    path = PurePosixPath(workdir)
    if not path.is_absolute() or ".." in path.parts or path != root and root not in path.parents:
        die(f"Cron workdir must stay inside {root}: {workdir}")
    return str(path)


def validate_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        die(f"Invalid timezone: {value}")
    return value


def validate_public_dir(public_dir: str | None) -> str:
    public_dir = (public_dir or "").strip().strip("/")
    if public_dir in {".", ".."} or public_dir.startswith("../") or "/../" in public_dir or public_dir.endswith("/.."):
        die(f"Invalid public_dir: {public_dir}")
    if not PUBLIC_DIR_RE.match(public_dir):
        die(f"Invalid public_dir: {public_dir}")
    return public_dir


def default_php_entrypoint(public_dir: str | None) -> str:
    return "front-controller" if validate_public_dir(public_dir) else "legacy"


def validate_php_entrypoint(value: str | None, public_dir: str | None = "") -> str:
    value = (value or "auto").strip().lower().replace("_", "-")
    if value in {"auto", ""}:
        return default_php_entrypoint(public_dir)
    if value in {"front", "frontcontroller", "index", "index-only", "single-index"}:
        value = "front-controller"
    if value in {"direct", "classic", "old", "old-way"}:
        value = "legacy"
    if value not in PHP_ENTRYPOINTS:
        die(f"Invalid PHP entrypoint: {value} (expected auto, front-controller, or legacy)")
    return value
