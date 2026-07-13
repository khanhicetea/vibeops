"""Cron command handlers."""
from __future__ import annotations

import argparse
import re
import shlex
from pathlib import Path
from typing import Any

from bento.commands.app_commands import ensure_app, resolve_app_php_version
from bento.services.cron_runtime import cron_jobs_dir_for
from bento.utils.env import default_php_version, stack_env
from bento.utils.errors import die, info
from bento.os.fsutil import mkdir
from bento.utils.paths import DOCROOT_NAME, PHP_TEMPLATE_DIR, RenderContext, rel
from bento.services.php import php_runner_service_for
from bento.services.rendering import write_template
from bento.services.state import cron_state_lock, load_db, save_db, upsert_timestamp
from bento.utils.validation import (
    APP_NAME_RE, CRON_LOCK_RE, JOB_RE, PHP_VERSION_RE,
    validate, validate_cron_workdir, validate_timezone
)

def safe_app_part(app_name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", app_name)

def safe_domain_part(domain: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", domain)

def validate_schedule(schedule: str) -> str:
    if not schedule or "\n" in schedule or "\r" in schedule:
        die("Invalid cron schedule")
    fields = schedule.split()
    if schedule.startswith("@"):
        if len(fields) != 1 or not re.fullmatch(r"@[A-Za-z]+", schedule):
            die(f"Invalid cron schedule: {schedule}")
    else:
        if len(fields) not in {5, 6, 7}:
            die("Cron schedule must have 5, 6, or 7 fields (or use an @ shortcut)")
        # Reject shell metacharacters offline; Supercronic -test performs the
        # authoritative expression validation before a running service reload.
        if any(not re.fullmatch(r"[A-Za-z0-9*?,/\-#LW]+", field) for field in fields):
            die(f"Invalid cron schedule: {schedule}")
    return schedule

def cron_render_values(cron: dict[str, Any]) -> dict[str, Any]:
    app_name = validate(str(cron.get("app", "")), APP_NAME_RE, "app_name")
    job_name = validate(str(cron.get("job_name", "")), JOB_RE, "job-name")
    php_version = validate(str(cron.get("php_version") or default_php_version()), PHP_VERSION_RE, "PHP version")
    php_service = php_runner_service_for(php_version)
    workdir = validate_cron_workdir(app_name, str(cron.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"))
    schedule = validate_schedule(str(cron.get("schedule", "")))
    command = str(cron.get("command", ""))
    if not command or "\x00" in command:
        die("Cron command is required and must not contain NUL")
    output = str(cron.get("output") or "docker")
    if output not in {"docker", "file"}:
        die(f"Invalid cron output mode: {output}")
    try:
        timeout = int(cron.get("timeout") or 0)
    except (TypeError, ValueError):
        die(f"Invalid cron timeout: {cron.get('timeout')}")
    if timeout < 0:
        die("Cron timeout cannot be negative")
    lock = str(cron.get("lock") or "-")
    if lock != "-":
        validate(lock, CRON_LOCK_RE, "cron lock")
    timezone = validate_timezone(str(cron.get("timezone") or stack_env().get("TZ", "UTC")))
    return {
        "USERNAME": app_name,
        "APP_NAME": app_name,
        "JOB_NAME": job_name,
        "PHP_VERSION": php_version,
        "PHP_SERVICE": php_service,
        "SCHEDULE": schedule,
        "TIMEZONE": timezone,
        "OUTPUT": output,
        "TIMEOUT": timeout,
        "QUOTED_USERNAME": shlex.quote(app_name),
        "QUOTED_JOB_NAME": shlex.quote(job_name),
        "QUOTED_WORKDIR": shlex.quote(workdir),
        "QUOTED_LOCK": shlex.quote(lock),
        "QUOTED_COMMAND": shlex.quote(command),
    }

def render_cron_job(cron: dict[str, Any], ctx: RenderContext | None = None) -> Path:
    values = cron_render_values(cron)
    php_version = str(values["PHP_VERSION"])
    app_name = str(values["APP_NAME"])
    job_name = str(values["JOB_NAME"])
    cron_path = cron_jobs_dir_for(php_version, ctx) / f"{safe_app_part(app_name)}-{job_name}.cron"
    mkdir(cron_jobs_dir_for(php_version, ctx))
    write_template(cron_path, PHP_TEMPLATE_DIR / "cron.cron.template", values, 0o644, generated=True)
    cron["php_service"] = values["PHP_SERVICE"]
    # State records the live path so stack.json stays mount-stable.
    cron["file"] = rel(cron_jobs_dir_for(php_version) / f"{safe_app_part(app_name)}-{job_name}.cron")
    return cron_path

def cmd_cron_create(args: argparse.Namespace) -> None:
    with cron_state_lock():
        db = load_db()
        app_name = validate(args.app_name, APP_NAME_RE, "app_name")
        job_name = validate(args.job_name, JOB_RE, "job-name")
        php_version = resolve_app_php_version(db, app_name, getattr(args, "php", None))
        workdir = validate_cron_workdir(app_name, args.workdir or f"/home/{app_name}/{DOCROOT_NAME}")
        output = getattr(args, "output", "docker")
        timeout = getattr(args, "timeout", 0)
        lock = getattr(args, "lock", None)
        timezone = getattr(args, "timezone", None) or stack_env().get("TZ", "UTC")

        candidate = {
            "app": app_name,
            "job_name": job_name,
            "php_version": php_version,
            "php_service": php_runner_service_for(php_version),
            "schedule": args.schedule,
            "command": args.command,
            "workdir": workdir,
            "output": output,
            "timeout": timeout,
            "lock": lock,
            "timezone": timezone,
        }
        # Validate every field before creating identities or generated config.
        cron_render_values(candidate)
        ensure_app(app_name, php_version, db)

        cron_key = f"{app_name}/{job_name}"
        cron = db["crons"].setdefault(cron_key, {})
        cron.update(candidate)
        upsert_timestamp(cron)
        from bento.commands.runtime_commands import apply_generated_config

        apply_generated_config(
            db,
            reload_services=True,
            validate_services=True,
            service_targets=frozenset({"runner"}),
        )
        save_db(db)
        cron_path = cron_jobs_dir_for(php_version) / f"{safe_app_part(app_name)}-{job_name}.cron"

        info(f"Created cron job: bento/{rel(cron_path)}")
        info(f"Runs as: {app_name}; workdir: {workdir}; timezone: {timezone}")
        info(f"Output: {output}; timeout: {timeout or 'none'}; lock: {lock or 'same-job (Supercronic)'}")

def cmd_cron_list(args: argparse.Namespace) -> None:
    from bento.ui.table import print_ascii_table as print_table

    db = load_db()
    app_name = getattr(args, "app_name", None)
    if app_name is not None:
        app_name = validate(app_name, APP_NAME_RE, "app_name")
    crons = [
        (key, cron) for key, cron in sorted(db.get("crons", {}).items())
        if isinstance(cron, dict) and (app_name is None or cron.get("app") == app_name)
    ]
    if not crons:
        if app_name:
            info(f"No cron jobs for {app_name}.")
        else:
            info("No crons in state. Create one with: ./manage.py cron create <app_name> <name> '<schedule>' '<command>'")
        return
    rows = []
    for index, (key, cron) in enumerate(crons, start=1):
        rows.append(
            [
                str(index),
                key,
                str(cron.get("php_version", "") or ""),
                str(cron.get("schedule", "") or ""),
                str(cron.get("timezone", stack_env().get("TZ", "UTC")) or ""),
                str(cron.get("output", "docker") or "docker"),
                str(cron.get("command", "") or ""),
            ]
        )
    print_table(rows, headers=["#", "JOB", "PHP", "SCHEDULE", "TZ", "OUTPUT", "COMMAND"])

def cmd_cron_remove(args: argparse.Namespace) -> None:
    with cron_state_lock():
        db = load_db()
        number = getattr(args, "number", None)
        if number is not None:
            if getattr(args, "app_name", None) or getattr(args, "job_name", None):
                die("Provide either an app name and job name or --number, not both")
            crons = [(key, cron) for key, cron in sorted(db.get("crons", {}).items()) if isinstance(cron, dict)]
            if not 1 <= number <= len(crons):
                die(f"Invalid cron number: {number}")
            cron_key, cron = crons[number - 1]
            app_name = validate(str(cron.get("app", "")), APP_NAME_RE, "app_name")
            job_name = validate(str(cron.get("job_name", "")), JOB_RE, "job-name")
        else:
            if not getattr(args, "app_name", None) or not getattr(args, "job_name", None):
                die("Provide an app name and job name, or --number from 'cron list'")
            app_name = validate(args.app_name, APP_NAME_RE, "app_name")
            job_name = validate(args.job_name, JOB_RE, "job-name")
            cron_key = f"{app_name}/{job_name}"
            cron = db.get("crons", {}).get(cron_key)
            if not isinstance(cron, dict):
                die(f"Unknown cron job: {cron_key}")

        php_version = validate(str(cron.get("php_version") or default_php_version()), PHP_VERSION_RE, "PHP version")
        db["crons"].pop(cron_key, None)
        from bento.commands.runtime_commands import apply_generated_config

        apply_generated_config(
            db,
            reload_services=True,
            validate_services=True,
            service_targets=frozenset({"runner"}),
        )
        save_db(db)
        info(f"Removed cron job: {cron_key}")

def cmd_cron_reload(args: argparse.Namespace) -> None:
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    with cron_state_lock():
        db = load_db()
        app_name = getattr(args, "app_name", None)
        if app_name is not None:
            app_name = validate(app_name, APP_NAME_RE, "app_name")
            if not any(
                isinstance(cron, dict) and cron.get("app") == app_name
                for cron in db.get("crons", {}).values()
            ):
                die(f"No cron jobs for {app_name}")
        from bento.commands.runtime_commands import apply_generated_config

        apply_generated_config(
            db,
            reload_services=True,
            validate_services=True,
            service_targets=frozenset({"runner"}),
        )
    info(f"Reloaded PHP {php_version} app schedulers")
