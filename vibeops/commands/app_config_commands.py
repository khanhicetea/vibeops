"""Headless app-scoped vhost and PHP-FPM pool customization commands."""

from __future__ import annotations

import argparse
from typing import Any

from vibeops.services.app_config import (
    APP_CONFIG_TARGETS,
    config_record,
    custom_template_path,
    install_custom_template,
    normalize_config_target,
    set_config_record,
    template_sha256,
    template_update_available,
    upstream_template_path,
)
from vibeops.services.state import load_db, save_db, serialized_cron_state, upsert_timestamp
from vibeops.ui.table import print_table
from vibeops.utils.errors import die, info, warn
from vibeops.utils.paths import rel
from vibeops.utils.validation import APP_NAME_RE, validate


def _load_app(app_name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    db = load_db()
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    app.setdefault("name", app_name)
    return db, app


def _service_targets(target: str) -> frozenset[str]:
    return frozenset({"nginx" if target == "vhost" else "php"})


@serialized_cron_state
def cmd_app_config_customize(args: argparse.Namespace) -> None:
    from vibeops.commands.runtime_commands import apply_generated_config

    target = normalize_config_target(args.target)
    db, app = _load_app(args.app_name)
    previous = config_record(app, target)
    source, created = install_custom_template(
        str(app["name"]),
        target,
        force=bool(getattr(args, "force", False)),
    )
    if not created:
        warn(f"Reusing existing custom source: vibeops/{rel(source)}")

    based_on = None
    if created or getattr(args, "force", False):
        based_on = template_sha256(upstream_template_path(target))
    elif previous.get("based_on_sha256"):
        based_on = str(previous["based_on_sha256"])

    set_config_record(app, target, mode="custom", based_on_sha256=based_on)
    upsert_timestamp(app)
    apply_generated_config(
        db,
        reload_services=not bool(getattr(args, "no_reload", False)),
        validate_services=True,
        service_targets=_service_targets(target),
    )
    save_db(db)
    info(f"App {app['name']} {target} now uses custom template: vibeops/{rel(source)}")
    info("Edit the custom source, then run ./manage.py apply")


@serialized_cron_state
def cmd_app_config_reset(args: argparse.Namespace) -> None:
    from vibeops.commands.runtime_commands import apply_generated_config

    target = normalize_config_target(args.target)
    db, app = _load_app(args.app_name)
    set_config_record(app, target, mode="generated")
    upsert_timestamp(app)
    apply_generated_config(
        db,
        reload_services=not bool(getattr(args, "no_reload", False)),
        validate_services=True,
        service_targets=_service_targets(target),
    )
    save_db(db)
    source = custom_template_path(str(app["name"]), target)
    info(f"App {app['name']} {target} now uses the upstream generated template")
    if source.exists():
        info(f"Preserved inactive custom source: vibeops/{rel(source)}")


def cmd_app_config_status(args: argparse.Namespace) -> None:
    _db, app = _load_app(args.app_name)
    rows: list[list[str]] = []
    for target in APP_CONFIG_TARGETS:
        record = config_record(app, target)
        mode = str(record["mode"])
        if mode == "custom":
            source = custom_template_path(str(app["name"]), target)
            update = template_update_available(app, target)
            update_text = "unknown" if update is None else ("yes" if update else "no")
        else:
            source = upstream_template_path(target)
            update_text = "-"
        rows.append([target, mode, rel(source), "yes" if source.is_file() else "MISSING", update_text])
    print_table(rows, headers=["TARGET", "MODE", "SOURCE", "EXISTS", "UPSTREAM CHANGED"])
