"""CLI for opt-in HMAC webhook deployments."""

from __future__ import annotations

import argparse
from pathlib import PurePosixPath
from typing import Any

from bento.commands.app_commands import resolve_app_php_version
from bento.services.deploy import (
    DEPLOY_CRON_JOB,
    DEPLOY_SKIP_EXIT_CODE,
    DEFAULT_QUEUE_POLICY,
    DEFAULT_TIMEOUT,
    QUEUE_POLICIES,
    default_command,
    deploy_cron_key,
    deploy_enabled,
    ensure_deploy_runtime,
    history_jobs,
    latest_job,
    new_webhook_secret,
    normalize_deploy,
    sync_deploy_cron,
    webhook_url,
    write_deploy_config,
    write_example_deploy_script,
)
from bento.services.state import load_db, render_lock, save_db, upsert_timestamp
from bento.ui.table import print_ascii_table as print_table
from bento.utils.errors import die, info
from bento.utils.paths import DOCROOT_NAME
from bento.utils.validation import APP_NAME_RE, validate, validate_cron_workdir


def add_parser(sub: argparse._SubParsersAction) -> None:
    deploy = sub.add_parser("deploy", help="Manage authenticated webhook deployments")
    deploy_sub = deploy.add_subparsers(dest="deploy_command", required=True)

    enable = deploy_sub.add_parser("enable", help="Enable a generic HMAC webhook for an app")
    enable.add_argument("app_name")
    enable.add_argument("--workdir", "-w", help="Workdir inside /home/<app>")
    enable.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Deployment timeout in seconds")
    enable.add_argument(
        "--queue-policy",
        choices=sorted(QUEUE_POLICIES),
        default=DEFAULT_QUEUE_POLICY,
        help="latest coalesces queued jobs; fifo processes all up to a cap",
    )
    enable.add_argument("--no-reload", action="store_true", help="Render but do not reload services")
    enable.add_argument(
        "deploy_command",
        nargs=argparse.REMAINDER,
        help="Trusted command argv (this option must be last); defaults to sh /home/<app>/.bento/deploy.sh",
    )
    enable.set_defaults(func=cmd_deploy_enable)

    disable = deploy_sub.add_parser("disable", help="Disable an app deployment webhook")
    disable.add_argument("app_name")
    disable.add_argument("--no-reload", action="store_true", help="Render but do not reload services")
    disable.set_defaults(func=cmd_deploy_disable)

    webhook = deploy_sub.add_parser("webhook", help="Print an app webhook URL and signature docs")
    webhook.add_argument("app_name")
    webhook.set_defaults(func=cmd_deploy_webhook)

    rotate = deploy_sub.add_parser("rotate-secret", help="Rotate and print an app webhook HMAC secret")
    rotate.add_argument("app_name")
    rotate.add_argument("--no-reload", action="store_true", help="Render but do not reload nginx")
    rotate.set_defaults(func=cmd_deploy_rotate_secret)

    status = deploy_sub.add_parser("status", help="Show the latest deployment status")
    status.add_argument("app_name")
    status.set_defaults(func=cmd_deploy_status)

    history = deploy_sub.add_parser("history", help="Show deployment history")
    history.add_argument("app_name")
    history.add_argument("--limit", type=int, default=20, help="Max jobs to show")
    history.set_defaults(func=cmd_deploy_history)


def _app(db: dict[str, Any], app_name: str) -> dict[str, Any]:
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    app.setdefault("name", app_name)
    return app


def _command_argv(args: argparse.Namespace, app_name: str) -> list[str]:
    command = list(getattr(args, "deploy_command", None) or [])
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        return default_command(app_name)
    if any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in command):
        die("Deployment command arguments must be non-empty and contain no NUL")
    return command


def _apply(db: dict[str, Any], *, no_reload: bool, targets: frozenset[str]) -> None:
    from bento.commands.runtime_commands import apply_generated_config

    apply_generated_config(
        db,
        reload_services=not no_reload,
        validate_services=True,
        service_targets=targets,
    )


def cmd_deploy_enable(args: argparse.Namespace) -> None:
    with render_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        app = _app(db, app_name)
        php_version = resolve_app_php_version(db, app_name, None, allow_new=False)
        workdir = validate_cron_workdir(
            app_name,
            args.workdir or str((app.get("deploy") or {}).get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"),
        )
        existing = app.get("deploy") if isinstance(app.get("deploy"), dict) else {}
        secret = str(existing.get("webhook_secret") or "").strip() or new_webhook_secret()
        created_secret = not bool(str(existing.get("webhook_secret") or "").strip())
        deploy = normalize_deploy(
            app_name,
            {
                **existing,
                "enabled": True,
                "timeout": args.timeout,
                "queue_policy": args.queue_policy,
                "workdir": workdir,
                "command": _command_argv(args, app_name),
                "webhook_secret": secret,
                "php_version": php_version,
            },
            php_version=php_version,
        )
        app["deploy"] = deploy
        upsert_timestamp(app)
        ensure_deploy_runtime(app_name)
        write_deploy_config(app_name, deploy)
        write_example_deploy_script(app_name)
        sync_deploy_cron(db, app_name)
        save_db(db)
        _apply(db, no_reload=bool(args.no_reload), targets=frozenset({"nginx", "runner"}))

    info(f"Enabled webhook deployment for {app_name} on PHP {php_version}")
    info(f"Webhook: {webhook_url(app)}")
    if created_secret:
        info(f"HMAC secret (save it now): {secret}")
    else:
        info("Existing HMAC secret kept; use 'deploy rotate-secret' to replace it")
    info("Signature header: X-Hub-Signature-256: sha256=<HMAC-SHA256(raw request body)>")
    info(f"Also accepted: X-Hub-Signature: sha256=<hex> (or sha1=<hex>)")
    info(f"Command: {' '.join(deploy['command'])}")
    info(f"Drain cron: {app_name}/{DEPLOY_CRON_JOB} (* * * * *, lock=deploy, timeout={deploy['timeout']}s)")
    info(f"Skip exit code: {DEPLOY_SKIP_EXIT_CODE}")
    info(f"Queue policy: {deploy['queue_policy']}; workdir: {deploy['workdir']}")


def cmd_deploy_disable(args: argparse.Namespace) -> None:
    with render_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        app = _app(db, app_name)
        if not deploy_enabled(app):
            die(f"Deployment is not enabled for {app_name}")
        deploy = normalize_deploy(app_name, {**(app.get("deploy") or {}), "enabled": False})
        # Keep secret/command so re-enable is easy, but do not put secret in nginx while disabled.
        app["deploy"] = deploy
        upsert_timestamp(app)
        sync_deploy_cron(db, app_name)
        # Drop managed cron if still present under the reserved key.
        db.get("crons", {}).pop(deploy_cron_key(app_name), None)
        save_db(db)
        _apply(db, no_reload=bool(args.no_reload), targets=frozenset({"nginx", "runner"}))
    info(f"Disabled webhook deployment for {app_name}")


def cmd_deploy_webhook(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = _app(db, app_name)
    if not deploy_enabled(app):
        die(f"Deployment is not enabled for {app_name}")
    deploy = normalize_deploy(app_name, app.get("deploy"))
    info(f"App: {app_name}")
    info(f"Webhook: {webhook_url(app)}")
    info("Signature header: X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body)>")
    info("Also accepted: X-Hub-Signature: sha256=<hex>")
    info(f"Queue policy: {deploy.get('queue_policy')}")
    info(f"Command: {' '.join(deploy.get('command') or [])}")
    # Do not print secret here; rotate-secret is explicit.
    secret = str(deploy.get("webhook_secret") or "")
    if secret:
        info(f"Secret is configured ({len(secret)} chars); use rotate-secret to replace/print a new one")


def cmd_deploy_rotate_secret(args: argparse.Namespace) -> None:
    with render_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        app = _app(db, app_name)
        if not deploy_enabled(app):
            die(f"Deployment is not enabled for {app_name}")
        secret = new_webhook_secret()
        deploy = normalize_deploy(
            app_name,
            {**(app.get("deploy") or {}), "enabled": True, "webhook_secret": secret},
            php_version=str(app.get("php_version") or ""),
        )
        app["deploy"] = deploy
        upsert_timestamp(app)
        write_deploy_config(app_name, deploy)
        sync_deploy_cron(db, app_name)
        save_db(db)
        _apply(db, no_reload=bool(args.no_reload), targets=frozenset({"nginx"}))
    info(f"Rotated deployment HMAC secret for {app_name}")
    info(f"HMAC secret (save it now): {secret}")
    info(f"Webhook: {webhook_url(app)}")


def cmd_deploy_status(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = _app(db, app_name)
    if not deploy_enabled(app):
        die(f"Deployment is not enabled for {app_name}")
    deploy = normalize_deploy(app_name, app.get("deploy"))
    info(f"App: {app_name}")
    info(f"Webhook: {webhook_url(app)}")
    info(f"Queue policy: {deploy.get('queue_policy')}")
    info(f"Timeout: {deploy.get('timeout')}s")
    info(f"Command: {' '.join(deploy.get('command') or [])}")
    job = latest_job(app_name)
    if not job:
        info("Status: no deployments received")
        return
    info(
        "Latest: "
        f"id={job.get('id')} status={job.get('status')} "
        f"exit={job.get('exit_code')} received={job.get('received_at')} "
        f"finished={job.get('finished_at')}"
    )
    if job.get("error"):
        info(f"Error: {job.get('error')}")
    if job.get("log_file"):
        log_name = PurePosixPath(str(job.get("log_file"))).name
        info(f"Log: /home/{app_name}/logs/{log_name}")


def cmd_deploy_history(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    _app(db, app_name)
    if not deploy_enabled(db["apps"][app_name]):
        die(f"Deployment is not enabled for {app_name}")
    jobs = history_jobs(app_name, limit=int(args.limit or 20))
    if not jobs:
        info(f"No deployment history for {app_name}")
        return
    rows = []
    for job in jobs:
        rows.append(
            [
                str(job.get("id", "")),
                str(job.get("status", "")),
                str(job.get("exit_code") if job.get("exit_code") is not None else ""),
                str(job.get("received_at", "")),
                str(job.get("finished_at", "") or ""),
                str(job.get("error") or "")[:40],
            ]
        )
    print_table(rows, headers=["ID", "STATUS", "EXIT", "RECEIVED", "FINISHED", "ERROR"])
