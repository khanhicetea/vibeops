"""App-scoped nginx access logs: paths, safe rotation, and adhoc GoAccess."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from bento.utils.env import goaccess_image
from bento.utils.errors import die, info, warn
from bento.os.fsutil import mkdir
from bento.utils.paths import NGINX_ACCESS_LOG_DIR, ROOT, rel
from bento.os.process import docker_available, run
from bento.utils.validation import APP_NAME_RE, validate

# Live log: <app>.access.log
# Rotated:  <app>.access.log-YYYYMMDDTHHMMSS[.gz]
_LIVE_SUFFIX = ".access.log"
_GOACCESS_LOG_FORMAT = '%h %^[%d:%t %^] "%r" %s %b "%R" "%u" %T %^'
_GOACCESS_FORMAT_ARGS = [
    f"--log-format={_GOACCESS_LOG_FORMAT}",
    "--date-format=%d/%b/%Y",
    "--time-format=%H:%M:%S",
    "--no-global-config",
]


def ensure_access_log_dir() -> Path:
    # Nginx workers must traverse this bind-mounted directory when logrotate
    # asks them to reopen a root-created live file.
    mkdir(NGINX_ACCESS_LOG_DIR, 0o751)
    return NGINX_ACCESS_LOG_DIR


def live_access_log_path(app_name: str) -> Path:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    return NGINX_ACCESS_LOG_DIR / f"{app_name}{_LIVE_SUFFIX}"


def container_access_log_path(app_name: str) -> str:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    return f"/var/log/nginx/apps/{app_name}{_LIVE_SUFFIX}"


def list_access_log_files(app_name: str) -> list[Path]:
    """Live file first (if present), then rotated archives newest-first."""
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    ensure_access_log_dir()
    live = live_access_log_path(app_name)
    prefix = f"{app_name}{_LIVE_SUFFIX}-"
    archives = sorted(
        (
            path
            for path in NGINX_ACCESS_LOG_DIR.iterdir()
            if path.is_file() and path.name.startswith(prefix)
        ),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    files: list[Path] = []
    if live.is_file():
        files.append(live)
    files.extend(archives)
    return files


def run_goaccess_analyze(
    app_name: str,
    *,
    html_path: Path | None = None,
) -> None:
    """Adhoc GoAccess over live + rotated files via a one-shot Docker image."""
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    if not docker_available():
        die("docker is required to run GoAccess")
    ensure_access_log_dir()
    files = list_access_log_files(app_name)
    if not files:
        die(
            f"No access log files for {app_name} under {rel(NGINX_ACCESS_LOG_DIR)}. "
            f"Enable with: ./manage.py app access-log enable {app_name}"
        )

    image = goaccess_image()
    mount = f"{NGINX_ACCESS_LOG_DIR.resolve()}:/logs:ro"
    container_files = [f"/logs/{path.name}" for path in files]

    base = [
        "docker",
        "run",
        "--rm",
        "-v",
        mount,
    ]

    if html_path is not None:
        out = html_path.expanduser().resolve()
        mkdir(out.parent)
        base.extend(["-v", f"{out.parent}:/out"])
        cmd = [
            *base,
            image,
            *container_files,
            *_GOACCESS_FORMAT_ARGS,
            "-o",
            f"/out/{out.name}",
        ]
        info(f"Analyzing {len(files)} log file(s) for {app_name} with {image}")
        run(cmd)
        info(f"Wrote GoAccess report: {out}")
        return

    if not sys.stdin.isatty() or not sys.stdout.isatty():
        die(
            "GoAccess TUI requires an interactive terminal; "
            "pass --html <path> for a static report"
        )
    cmd = [
        *base,
        "-it",
        image,
        *container_files,
        *_GOACCESS_FORMAT_ARGS,
    ]
    info(f"Analyzing {len(files)} log file(s) for {app_name} with {image} (TUI)")
    os.chdir(ROOT)
    os.execvp("docker", cmd)
