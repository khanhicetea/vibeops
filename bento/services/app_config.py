"""App-scoped custom service template ownership and provenance."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from bento.os.fsutil import mkdir, write_text_atomic
from bento.utils.errors import die
from bento.utils.paths import CUSTOM_DIR, NGINX_TEMPLATE_DIR, PHP_TEMPLATE_DIR, rel
from bento.utils.validation import APP_NAME_RE, validate

APP_CONFIG_TARGETS = ("vhost", "pool")


def normalize_config_target(target: str) -> str:
    value = str(target).strip().lower()
    if value not in APP_CONFIG_TARGETS:
        die(f"Unknown app config target: {target}; expected one of: {', '.join(APP_CONFIG_TARGETS)}")
    return value


def upstream_template_path(target: str) -> Path:
    target = normalize_config_target(target)
    if target == "vhost":
        return NGINX_TEMPLATE_DIR / "site.conf.template"
    return PHP_TEMPLATE_DIR / "pool.conf.template"


def custom_template_path(app_name: str, target: str) -> Path:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    target = normalize_config_target(target)
    if target == "vhost":
        return CUSTOM_DIR / "apps" / app_name / "nginx" / "vhost.conf.template"
    return CUSTOM_DIR / "apps" / app_name / "php" / "pool.conf.template"


def template_sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        die(f"Cannot read template {rel(path)}: {exc}")
    raise AssertionError("unreachable")


def config_record(app: dict[str, Any], target: str) -> dict[str, Any]:
    """Return a validated config record; absent state means generated mode."""
    target = normalize_config_target(target)
    service_config = app.get("service_config")
    if service_config is None:
        return {"mode": "generated"}
    if not isinstance(service_config, dict):
        die(f"App {app.get('name', '')} service_config must be an object")
    raw = service_config.get(target)
    if raw is None:
        return {"mode": "generated"}
    if not isinstance(raw, dict):
        die(f"App {app.get('name', '')} service_config.{target} must be an object")
    mode = str(raw.get("mode") or "generated")
    if mode not in {"generated", "custom"}:
        die(f"Invalid service_config.{target}.mode: {mode!r}; expected generated or custom")
    record = dict(raw)
    record["mode"] = mode
    if mode == "custom":
        app_name = validate(str(app.get("name", "")), APP_NAME_RE, "app_name")
        expected = rel(custom_template_path(app_name, target))
        source = str(record.get("source") or expected)
        if source != expected:
            die(
                f"App {app_name} custom {target} source must be {expected}; "
                "custom sources cannot point outside the app-scoped directory"
            )
        record["source"] = source
    return record


def normalize_service_config(app_name: str, value: Any) -> dict[str, Any]:
    """Normalize persisted service config while rejecting unknown targets."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        die(f"App {app_name} service_config must be an object")
    unknown = set(value) - set(APP_CONFIG_TARGETS)
    if unknown:
        die(f"App {app_name} has unknown service config target(s): {', '.join(sorted(unknown))}")
    probe = {"name": app_name, "service_config": value}
    return {target: config_record(probe, target) for target in value}


def selected_template_path(app: dict[str, Any], target: str) -> Path:
    """Resolve the upstream or app-owned template selected by desired state."""
    target = normalize_config_target(target)
    record = config_record(app, target)
    if record["mode"] == "generated":
        return upstream_template_path(target)
    path = custom_template_path(str(app.get("name", "")), target)
    if not path.is_file():
        die(f"Missing custom {target} template: {rel(path)}")
    return path


def install_custom_template(app_name: str, target: str, *, force: bool = False) -> tuple[Path, bool]:
    """Create an app-owned template from the current upstream template."""
    target = normalize_config_target(target)
    source = upstream_template_path(target)
    destination = custom_template_path(app_name, target)
    if destination.exists() and not destination.is_file():
        die(f"Custom {target} source is not a regular file: {rel(destination)}")
    if destination.exists() and not force:
        return destination, False
    if not source.is_file():
        die(f"Missing upstream template: {rel(source)}")
    marker = "#" if target == "vhost" else ";"
    contract = (
        "Preserve template variables and the BEGIN/END TLS_CERTIFICATE markers."
        if target == "vhost"
        else "Preserve template variables plus the app identity and Unix-socket contract."
    )
    header = (
        f"{marker} bento CUSTOM APP TEMPLATE. This source is user-owned and survives renders.\n"
        f"{marker} {contract}\n"
    )
    mkdir(destination.parent, 0o700)
    write_text_atomic(destination, header + source.read_text(), 0o644)
    return destination, True


def set_config_record(
    app: dict[str, Any],
    target: str,
    *,
    mode: str,
    based_on_sha256: str | None = None,
) -> dict[str, Any]:
    target = normalize_config_target(target)
    if mode not in {"generated", "custom"}:
        die(f"Invalid app config mode: {mode}")
    service_config = app.setdefault("service_config", {})
    if not isinstance(service_config, dict):
        die(f"App {app.get('name', '')} service_config must be an object")
    previous = service_config.get(target)
    record: dict[str, Any] = dict(previous) if isinstance(previous, dict) else {}
    record["mode"] = mode
    if mode == "custom":
        record["source"] = rel(custom_template_path(str(app.get("name", "")), target))
        if based_on_sha256:
            record["based_on_sha256"] = based_on_sha256
    service_config[target] = record
    return record


def template_update_available(app: dict[str, Any], target: str) -> bool | None:
    record = config_record(app, target)
    if record["mode"] != "custom":
        return False
    based_on = record.get("based_on_sha256")
    if not based_on:
        return None
    return str(based_on) != template_sha256(upstream_template_path(target))
