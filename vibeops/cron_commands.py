"""Cron command handlers."""
from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from vibeops.helpers import *  # noqa: F403
from vibeops.app_commands import ensure_app

def safe_app_part(app_name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", app_name)


def safe_domain_part(domain: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", domain)


def cmd_cron_create(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    job_name = validate(args.job_name, JOB_RE, "job-name")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    schedule = args.schedule
    command = args.command
    if not schedule or not command:
        die("schedule and command are required")
    php_service = php_cron_service_for(php_version)
    workdir = args.workdir or f"/home/{app_name}/{DOCROOT_NAME}"

    ensure_app(app_name, php_version, db)
    mkdir(cron_jobs_dir_for(php_version))
    mkdir(app_www(app_name))

    cron_path = cron_jobs_dir_for(php_version) / f"{safe_app_part(app_name)}-{job_name}.cron"
    write_template(cron_path, PHP_TEMPLATE_DIR / "cron.cron.template", {
        "USERNAME": app_name,
        "APP_NAME": app_name,
        "DOMAIN": DOCROOT_NAME,
        "PHP_VERSION": php_version,
        "PHP_SERVICE": php_service,
        "SCHEDULE": schedule,
        "QUOTED_USERNAME": shlex.quote(app_name),
        "QUOTED_WORKDIR": shlex.quote(workdir),
        "QUOTED_COMMAND": shlex.quote(command),
    }, 0o644, generated=True)

    info(f"Created cron job: vibeops/{rel(cron_path)}")
    info(f"Runs as: {app_name}")
    info(f"Workdir: {workdir}")
    combined_crontab = rebuild_supercronic_crontab(php_version)
    info(f"Updated Supercronic crontab: vibeops/{rel(combined_crontab)}")
    info(f"Command: {command}")

    cron_key = f"{app_name}/{job_name}"
    cron = db["crons"].setdefault(cron_key, {})
    cron.update({
        "app": app_name,
        "job_name": job_name,
        "php_version": php_version,
        "php_service": php_service,
        "schedule": schedule,
        "command": command,
        "workdir": workdir,
        "file": rel(cron_path),
    })
    upsert_timestamp(cron)
    save_db(db)
    cron_reload(php_service, [app_name])


def cmd_cron_reload(args: argparse.Namespace) -> None:
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    combined_crontab = rebuild_supercronic_crontab(php_version)
    info(f"Updated Supercronic crontab: vibeops/{rel(combined_crontab)}")
    cron_reload(php_cron_service_for(php_version))


def render_cron_job(cron: dict[str, Any]) -> Path:
    app_name = validate(str(cron.get("app", "")), APP_NAME_RE, "app_name")
    job_name = validate(str(cron.get("job_name", "")), JOB_RE, "job-name")
    php_version = validate(str(cron.get("php_version") or default_php_version()), PHP_VERSION_RE, "PHP version")
    php_service = php_cron_service_for(php_version)
    workdir = str(cron.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}")
    cron_path = cron_jobs_dir_for(php_version) / f"{safe_app_part(app_name)}-{job_name}.cron"
    mkdir(cron_jobs_dir_for(php_version))
    write_template(cron_path, PHP_TEMPLATE_DIR / "cron.cron.template", {
        "USERNAME": app_name,
        "APP_NAME": app_name,
        "DOMAIN": DOCROOT_NAME,
        "PHP_VERSION": php_version,
        "PHP_SERVICE": php_service,
        "SCHEDULE": cron.get("schedule", ""),
        "QUOTED_USERNAME": shlex.quote(app_name),
        "QUOTED_WORKDIR": shlex.quote(workdir),
        "QUOTED_COMMAND": shlex.quote(str(cron.get("command", ""))),
    }, 0o644, generated=True)
    cron["php_service"] = php_service
    cron["file"] = rel(cron_path)
    return cron_path
