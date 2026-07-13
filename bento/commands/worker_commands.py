"""Long-running app worker management through versioned Supervisord runners."""

from __future__ import annotations

import argparse
from typing import Any

from bento.commands.app_commands import resolve_app_php_version
from bento.os.process import run, service_running
from bento.services.compose import compose_command
from bento.services.php import php_runner_service_for
from bento.services.runner import normalize_worker, worker_targets
from bento.services.state import cron_state_lock, load_db, save_db, upsert_timestamp
from bento.ui.table import print_ascii_table as print_table
from bento.utils.errors import die, info
from bento.utils.paths import DOCROOT_NAME
from bento.utils.validation import APP_NAME_RE, JOB_RE, validate, validate_cron_workdir


def add_parser(sub: argparse._SubParsersAction) -> None:
    worker = sub.add_parser("worker", help="Manage long-running app processes")
    worker_sub = worker.add_subparsers(dest="worker_action", required=True)
    create = worker_sub.add_parser("create", help="Create/update a supervised app worker")
    create.add_argument("app_name")
    create.add_argument("worker_name")
    create.add_argument("--php", default=None, help="PHP version; must match the app runtime")
    create.add_argument("--workdir", "-w", help="Workdir inside /home/<app>")
    create.add_argument("--stop-timeout", type=int, default=120, help="Grace period before SIGKILL")
    create.add_argument("worker_command", nargs=argparse.REMAINDER, help="Command argv; prefix with --")
    create.set_defaults(func=cmd_worker_create)
    listing = worker_sub.add_parser("list", help="List configured workers")
    listing.add_argument("--app", dest="app_name", help="Only workers for this app")
    listing.set_defaults(func=cmd_worker_list)
    remove = worker_sub.add_parser("remove", aliases=["delete"], help="Remove a supervised worker")
    remove.add_argument("app_name")
    remove.add_argument("worker_name")
    remove.set_defaults(func=cmd_worker_remove)
    for action in ("status", "start", "stop", "restart"):
        control = worker_sub.add_parser(action, help=f"{action.capitalize()} one worker or all workers for an app")
        control.add_argument("app_name")
        control.add_argument("worker_name", nargs="?")
        control.set_defaults(func=cmd_worker_control)


def _worker_key(app_name: str, name: str) -> str:
    return f"{app_name}/{name}"


def _find_worker(db: dict[str, Any], app_name: str, name: str) -> dict[str, Any]:
    worker = db.get("workers", {}).get(_worker_key(app_name, name))
    if not isinstance(worker, dict):
        die(f"Unknown worker: {app_name}/{name}")
    return normalize_worker(worker)


def cmd_worker_create(args: argparse.Namespace) -> None:
    with cron_state_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        name = validate(args.worker_name, JOB_RE, "worker name")
        php_version = resolve_app_php_version(db, app_name, getattr(args, "php", None), allow_new=False)
        workdir = validate_cron_workdir(app_name, args.workdir or f"/home/{app_name}/{DOCROOT_NAME}")
        command = list(args.worker_command or [])
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            die("Worker command is required; pass it after --")
        candidate = normalize_worker({
            "app": app_name,
            "name": name,
            "php_version": php_version,
            "workdir": workdir,
            "command": command,
            "stop_timeout": args.stop_timeout,
            "enabled": True,
        })
        worker = db["workers"].setdefault(_worker_key(app_name, name), {})
        worker.update(candidate)
        upsert_timestamp(worker)

        from bento.commands.runtime_commands import apply_generated_config

        apply_generated_config(
            db,
            reload_services=True,
            validate_services=True,
            service_targets=frozenset({"runner"}),
        )
        save_db(db)
        info(f"Created worker {app_name}/{name} on {php_runner_service_for(php_version)}")
        info(f"Command: {' '.join(command)}")


def cmd_worker_list(args: argparse.Namespace) -> None:
    db = load_db()
    app_filter = getattr(args, "app_name", None)
    if app_filter:
        app_filter = validate(app_filter, APP_NAME_RE, "app_name")
    rows: list[list[str]] = []
    for key, raw in sorted(db.get("workers", {}).items()):
        if not isinstance(raw, dict):
            continue
        worker = normalize_worker(raw)
        if app_filter and worker["app"] != app_filter:
            continue
        rows.append([
            key,
            str(worker["php_version"]),
            "yes" if worker["enabled"] else "no",
            str(worker["workdir"]),
            " ".join(worker["command"]),
        ])
    if not rows:
        info(f"No workers for {app_filter}." if app_filter else "No workers configured.")
        return
    print_table(rows, headers=["WORKER", "PHP", "ENABLED", "WORKDIR", "COMMAND"])


def cmd_worker_remove(args: argparse.Namespace) -> None:
    with cron_state_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        name = validate(args.worker_name, JOB_RE, "worker name")
        _find_worker(db, app_name, name)
        db["workers"].pop(_worker_key(app_name, name))

        from bento.commands.runtime_commands import apply_generated_config

        apply_generated_config(
            db,
            reload_services=True,
            validate_services=True,
            service_targets=frozenset({"runner"}),
        )
        save_db(db)
        info(f"Removed worker {app_name}/{name}")


def cmd_worker_control(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    name = getattr(args, "worker_name", None)
    if name is not None:
        name = validate(name, JOB_RE, "worker name")
        worker = _find_worker(db, app_name, name)
        version = str(worker["php_version"])
    else:
        workers = [
            normalize_worker(worker)
            for worker in db.get("workers", {}).values()
            if isinstance(worker, dict) and worker.get("app") == app_name
        ]
        if not workers:
            die(f"No workers for {app_name}")
        versions = {str(worker["php_version"]) for worker in workers}
        if len(versions) != 1:
            die(f"Workers for {app_name} span multiple PHP versions; select a worker name")
        version = versions.pop()

    service = php_runner_service_for(version)
    if not service_running(service):
        die(f"{service} is not running")
    targets = worker_targets(db, app_name, name)
    if not targets:
        die(f"No workers for {app_name}")
    action = args.worker_action
    run(
        compose_command(
            "exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf", action, *targets
        )
    )
    if action != "status":
        info(f"{action.capitalize()} requested for {', '.join(targets)}")
