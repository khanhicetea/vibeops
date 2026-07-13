"""Explicit PHP identity synchronization and app permission commands."""
from __future__ import annotations

from bento.services.compose import compose_prefix

import argparse
import json
import sys
from collections import defaultdict
from typing import Any

from bento.utils.env import default_php_version
from bento.utils.errors import die, warn
from bento.services.php import php_cli_service_for, php_service_for
from bento.os.process import docker_available, run, service_running
from bento.services.state import load_db
from bento.utils.validation import APP_NAME_RE, PHP_VERSION_RE, validate

def _select_apps(args: argparse.Namespace) -> list[tuple[str, dict[str, Any], str]]:
    """Validate selection and return app records with their target PHP version."""
    app_name = getattr(args, "app_name", None)
    all_apps = bool(getattr(args, "all", False))
    explicit_php = getattr(args, "php", None)
    if bool(app_name) == all_apps:
        die("Provide exactly one app_name or --all")
    if all_apps and explicit_php:
        die("--php may only be used with one app")
    db = load_db()
    if all_apps:
        selected = [(name, app) for name, app in sorted(db.get("apps", {}).items()) if isinstance(app, dict)]
        if not selected:
            die("No apps in state")
    else:
        app_name = validate(str(app_name), APP_NAME_RE, "app_name")
        app = db.get("apps", {}).get(app_name)
        if not isinstance(app, dict):
            die(f"Unknown app: {app_name}")
        selected = [(app_name, app)]
    result: list[tuple[str, dict[str, Any], str]] = []
    for name, app in selected:
        version = explicit_php or str(app.get("php_version") or default_php_version())
        result.append((name, app, validate(version, PHP_VERSION_RE, "PHP version")))
    return result

def _container_command(version: str, helper: str, helper_args: list[str]) -> list[str]:
    service = php_service_for(version)
    if service_running(service):
        return [*compose_prefix(), "exec", "-T", service, helper, *helper_args]
    return [*compose_prefix(),
        "run", "--rm", "--entrypoint", helper,
        php_cli_service_for(version), *helper_args,
    ]

def cmd_identity_sync(args: argparse.Namespace) -> None:
    if not docker_available():
        die("docker is required")
    grouped: dict[str, list[str]] = defaultdict(list)
    for name, _, version in _select_apps(args):
        grouped[version].append(name)
    for version, names in sorted(grouped.items()):
        run(_container_command(version, "php-identity-sync", sorted(names)))

def _permission_args(args: argparse.Namespace, app_name: str) -> list[str]:
    helper_args = [args.permission_action, app_name]
    if args.permission_action == "fix":
        if getattr(args, "recursive", False):
            helper_args.append("--recursive")
        if getattr(args, "dry_run", False):
            helper_args.append("--dry-run")
    if getattr(args, "json", False):
        helper_args.append("--json")
    return helper_args

def initialize_app_permissions(app_name: str, version: str) -> bool:
    """Apply the complete filesystem policy once after an app is created."""
    if not docker_available():
        warn(f"Docker is unavailable; after the PHP image is available run: ./manage.py permissions fix {app_name} --recursive")
        return False
    cp = run(_container_command(version, "php-permissions", ["fix", app_name, "--recursive"]), check=False)
    if cp.returncode != 0:
        warn(f"Initial permission repair could not run; after PHP is available run: ./manage.py permissions fix {app_name} --recursive")
        return False
    return True

def cmd_permissions(args: argparse.Namespace) -> None:
    if not docker_available():
        die("docker is required")
    selected = _select_apps(args)
    want_json = bool(getattr(args, "json", False))
    results: list[dict[str, Any]] = []
    failures: list[str] = []
    for app_name, _, version in selected:
        cp = run(
            _container_command(version, "php-permissions", _permission_args(args, app_name)),
            check=False,
            capture=want_json,
        )
        if want_json:
            if cp.stderr:
                print(cp.stderr, end="", file=sys.stderr)
            try:
                result = json.loads(cp.stdout)
            except json.JSONDecodeError:
                failures.append(app_name)
                result = {"app": app_name, "action": args.permission_action, "failed": 1, "clean": False}
            results.append(result)
        if cp.returncode != 0:
            failures.append(app_name)
    if want_json:
        print(json.dumps(results[0] if len(results) == 1 else results))
    if failures:
        die("permission operation failed for: " + ", ".join(dict.fromkeys(failures)))
