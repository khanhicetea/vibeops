"""App-scoped nginx access logs: paths, safe rotation, and adhoc GoAccess."""

from __future__ import annotations

import datetime as dt
import gzip
import os
import shutil
import sys
from pathlib import Path

from bento.utils.env import (
    goaccess_image,
    nginx_access_log_max_size_bytes,
    nginx_access_log_rotate_count,
)
from bento.utils.errors import die, info, warn
from bento.os.fsutil import mkdir
from bento.utils.paths import NGINX_ACCESS_LOG_DIR, ROOT, rel
from bento.os.process import docker_available, run, service_running
from bento.utils.validation import APP_NAME_RE, validate

# Live log: <app>.access.log
# Rotated:  <app>.access.log-YYYYMMDDTHHMMSS[.gz]
_LIVE_SUFFIX = ".access.log"


def ensure_access_log_dir() -> Path:
    mkdir(NGINX_ACCESS_LOG_DIR, 0o750)
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


def nginx_reopen_logs() -> None:
    """Re-open log files without reloading config (USR1 / nginx -s reopen).

    Safe after rename-based rotation: workers finish writing the old inode, then
    open a new live path. Does not break in-flight requests or re-read config.
    """
    if not docker_available():
        die("docker is required to reopen nginx access logs")
    if not service_running("nginx"):
        warn("nginx is not running; rotated files are on disk but reopen was skipped")
        return
    run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-s", "reopen"])
    info("Reopened nginx log files")


def _gzip_file(path: Path) -> Path:
    gz_path = path.with_name(path.name + ".gz")
    if gz_path.exists():
        return gz_path
    with path.open("rb") as src, gzip.open(gz_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    path.unlink(missing_ok=True)
    return gz_path


def _prune_archives(app_name: str, keep: int) -> int:
    """Keep at most *keep* rotated archives for the app; return number removed."""
    if keep < 0:
        return 0
    app_name = validate(app_name, APP_NAME_RE, "app_name")
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
    removed = 0
    for path in archives[keep:]:
        path.unlink(missing_ok=True)
        removed += 1
    return removed


def _should_rotate(live: Path, *, force: bool, max_size: int) -> bool:
    if not live.is_file():
        return False
    try:
        size = live.stat().st_size
    except OSError:
        return False
    if size == 0 and not force:
        return False
    if not force and size < max_size:
        return False
    return True


def _rename_live_log(live: Path) -> tuple[Path, int] | None:
    """Rename live log to a timestamped archive. Returns (archive, size) or None."""
    try:
        size = live.stat().st_size
    except OSError:
        return None
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    archive = live.with_name(f"{live.name}-{stamp}")
    n = 0
    while archive.exists():
        n += 1
        archive = live.with_name(f"{live.name}-{stamp}-{n}")
    os.replace(live, archive)
    return archive, size


def _finish_archives(app_archives: list[tuple[str, Path]]) -> None:
    """Compress renamed archives and prune by app. Does not touch nginx."""
    keep = nginx_access_log_rotate_count()
    for app_name, archive in app_archives:
        try:
            gz = _gzip_file(archive)
            info(f"Compressed bento/{rel(gz)}")
        except OSError as exc:
            warn(f"could not compress bento/{rel(archive)}: {exc}")
        removed = _prune_archives(app_name, keep)
        if removed:
            info(f"Pruned {removed} old access-log archive(s) for {app_name}")


def rotate_app_access_log(app_name: str, *, force: bool = False) -> bool:
    """Rename oversized live log, reopen nginx once, compress, prune.

    Returns True when a rotation was performed.
    """
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    ensure_access_log_dir()
    live = live_access_log_path(app_name)
    max_size = nginx_access_log_max_size_bytes()
    if not _should_rotate(live, force=force, max_size=max_size):
        return False

    renamed = _rename_live_log(live)
    if renamed is None:
        return False
    archive, size = renamed
    info(f"Rotated bento/{rel(live)} -> bento/{rel(archive)} ({size} bytes)")
    # Reopen after rename so workers open a fresh live path (no config reload).
    nginx_reopen_logs()
    _finish_archives([(app_name, archive)])
    return True


def rotate_all_access_logs(*, force: bool = False) -> int:
    """Rotate all live app access logs that exceed the configured max size.

    Renames every eligible live file first, then a single ``nginx -s reopen``,
    then compress/prune. Avoids reloading nginx config.
    """
    ensure_access_log_dir()
    max_size = nginx_access_log_max_size_bytes()
    pending: list[tuple[str, Path, int]] = []

    for live in sorted(NGINX_ACCESS_LOG_DIR.glob(f"*{_LIVE_SUFFIX}")):
        if not live.is_file():
            continue
        name = live.name
        if not name.endswith(_LIVE_SUFFIX):
            continue
        app_name = name[: -len(_LIVE_SUFFIX)]
        try:
            validate(app_name, APP_NAME_RE, "app_name")
        except Exception:
            continue
        if not _should_rotate(live, force=force, max_size=max_size):
            continue
        renamed = _rename_live_log(live)
        if renamed is None:
            continue
        archive, size = renamed
        pending.append((app_name, archive, size))
        info(f"Rotated bento/{rel(live)} -> bento/{rel(archive)} ({size} bytes)")

    if not pending:
        info("No access logs needed rotation")
        return 0

    nginx_reopen_logs()
    _finish_archives([(app_name, archive) for app_name, archive, _ in pending])
    info(f"Rotated {len(pending)} access log file(s)")
    return len(pending)


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
            f"No access log files for {app_name} under bento/{rel(NGINX_ACCESS_LOG_DIR)}. "
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
            "--log-format=COMBINED",
            "--no-global-config",
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
        "--log-format=COMBINED",
        "--no-global-config",
    ]
    info(f"Analyzing {len(files)} log file(s) for {app_name} with {image} (TUI)")
    os.chdir(ROOT)
    os.execvp("docker", cmd)
