"""CLI for app-scoped nginx access logs, rotation, and GoAccess analysis."""

from __future__ import annotations

import argparse
from pathlib import Path

from bento.services.access_log import (
    ensure_access_log_dir,
    list_access_log_files,
    live_access_log_path,
    run_goaccess_analyze,
)
from bento.utils.errors import die, info, warn
from bento.utils.paths import rel
from bento.services.state import load_db, save_db, upsert_timestamp
from bento.utils.validation import APP_NAME_RE, validate


def cmd_app_access_log(args: argparse.Namespace) -> None:
    """Enable, disable, or show app-scoped nginx access logging."""
    from bento.commands.runtime_commands import SERVICE_TARGETS_NGINX, apply_generated_config

    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    action = str(args.access_log_action)

    if action == "status":
        enabled = bool(app.get("access_log"))
        live = live_access_log_path(app_name)
        files = list_access_log_files(app_name)
        info(f"access_log: {'on' if enabled else 'off'}")
        info(
            f"live path: {rel(live)}"
            + (f" ({live.stat().st_size} bytes)" if live.is_file() else " (absent)")
        )
        if files:
            for path in files:
                try:
                    size = path.stat().st_size
                except OSError:
                    size = 0
                info(f"  {rel(path)} ({size} bytes)")
        else:
            info("  (no log files yet)")
        return

    enabled = action == "enable"
    previous = bool(app.get("access_log"))
    if previous == enabled:
        info(f"access_log already {'on' if enabled else 'off'} for {app_name}")
        return

    app["access_log"] = enabled
    if enabled:
        ensure_access_log_dir()
    upsert_timestamp(app)
    apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
        service_targets=SERVICE_TARGETS_NGINX,
    )
    save_db(db)
    info(f"access_log {'enabled' if enabled else 'disabled'} for {app_name}")
    if enabled:
        info(f"Logs: {rel(live_access_log_path(app_name))}")
        info(f"Analyze: ./manage.py app logs analyze {app_name}")


def cmd_app_logs_analyze(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    if not app.get("access_log"):
        warn(f"access_log is off for {app_name}; analyzing existing files if any")
    html = Path(args.html) if getattr(args, "html", None) else None
    run_goaccess_analyze(app_name, html_path=html)


def cmd_logs_rotate(args: argparse.Namespace) -> None:
    """Backward-compatible alias for the stack maintenance logrotate job."""
    from bento.commands.maintenance_commands import run_maintenance

    run_maintenance(force=bool(getattr(args, "force", False)))
