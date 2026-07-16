"""Opt-in authenticated webhook deploy configuration and runtime helpers."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any

from bento.os.fsutil import mkdir, write_text, write_text_atomic
from bento.services.php import app_home, php_service_for
from bento.utils.errors import die, warn
from bento.utils.paths import DOCROOT_NAME, HOME_DIR, rel
from bento.utils.validation import APP_NAME_RE, validate, validate_cron_workdir

BENTO_DIR_NAME = ".bento"
QUEUE_FILE_NAME = "queue.json"
DEPLOY_SCRIPT_NAME = "deploy.sh"
DEPLOY_CRON_JOB = "bento-deploy-drain"
DEPLOY_SKIP_EXIT_CODE = 99
QUEUE_RETENTION = 30
DEFAULT_TIMEOUT = 900
DEFAULT_QUEUE_POLICY = "latest"
MAX_TIMEOUT = 86400
MAX_BODY_BYTES = 256 * 1024
QUEUE_POLICIES = frozenset({"latest", "fifo"})
FIFO_MAX_QUEUED = 20


def bento_dir(app_name: str) -> Path:
    return app_home(app_name) / BENTO_DIR_NAME


def queue_path(app_name: str) -> Path:
    return bento_dir(app_name) / QUEUE_FILE_NAME


def deploy_script_path(app_name: str) -> Path:
    return bento_dir(app_name) / DEPLOY_SCRIPT_NAME


def deploy_cron_key(app_name: str) -> str:
    return f"{app_name}/{DEPLOY_CRON_JOB}"


def deploy_enabled(app: dict[str, Any] | None) -> bool:
    if not isinstance(app, dict):
        return False
    deploy = app.get("deploy")
    return isinstance(deploy, dict) and bool(deploy.get("enabled"))


def new_webhook_secret() -> str:
    return secrets.token_hex(32)


def default_command(app_name: str) -> list[str]:
    return ["sh", f"/home/{app_name}/{BENTO_DIR_NAME}/{DEPLOY_SCRIPT_NAME}"]


def normalize_deploy(app_name: str, deploy: dict[str, Any] | None, *, php_version: str | None = None) -> dict[str, Any]:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    raw = dict(deploy or {})
    enabled = bool(raw.get("enabled"))
    workdir = validate_cron_workdir(
        app_name,
        str(raw.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"),
    )
    command = raw.get("command")
    if command is None:
        command = default_command(app_name)
    if not isinstance(command, list) or not command:
        die(f"Deployment command for app {app_name} must be a non-empty argv list")
    command = [str(arg) for arg in command]
    if any(not arg or "\x00" in arg for arg in command):
        die(f"Deployment command for app {app_name} must be a non-empty argv list without NUL")
    try:
        timeout = int(raw.get("timeout") if raw.get("timeout") is not None else DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        die(f"Invalid deployment timeout for app {app_name}")
    if timeout < 1 or timeout > MAX_TIMEOUT:
        die(f"Deployment timeout must be between 1 and {MAX_TIMEOUT} seconds")
    queue_policy = str(raw.get("queue_policy") or DEFAULT_QUEUE_POLICY).strip().lower()
    if queue_policy not in QUEUE_POLICIES:
        die("Deployment queue policy must be latest or fifo")
    secret = str(raw.get("webhook_secret") or "").strip()
    if enabled and not secret:
        die(f"Deployment webhook_secret is required when deploy is enabled for {app_name}")
    if secret and any(ch in secret for ch in "\n\r\x00"):
        die(f"Invalid webhook_secret for app {app_name}")
    out: dict[str, Any] = {
        "enabled": enabled,
        "timeout": timeout,
        "queue_policy": queue_policy,
        "workdir": workdir,
        "command": command,
        "webhook_secret": secret,
    }
    if php_version:
        out["php_version"] = php_version
    for key in ("created_at", "updated_at"):
        if raw.get(key):
            out[key] = raw[key]
    return out


def empty_queue() -> dict[str, Any]:
    return {"version": 1, "jobs": []}


def deploy_config_path(app_name: str) -> Path:
    return bento_dir(app_name) / "deploy.json"


def ensure_deploy_runtime(app_name: str, *, uid: int | None = None) -> Path:
    """Create private .bento runtime dirs and an empty queue if missing."""
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    root = bento_dir(app_name)
    mkdir(root, 0o700)
    mkdir(app_home(app_name) / "logs", 0o700)
    qpath = queue_path(app_name)
    if not qpath.exists():
        write_text_atomic(qpath, json.dumps(empty_queue(), indent=2) + "\n", mode=0o640)
    if uid is not None:
        own_deploy_runtime(app_name, uid)
    return root


def own_deploy_runtime(app_name: str, uid: int) -> None:
    """Chown ``.bento`` (and contents) to the app UID/GID.

    Host-side manage.py creates these files as the operator user; the app user
    must own them for FPM webhook enqueue and the drain cron.
    """
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    if uid < 0:
        return
    root = bento_dir(app_name)
    if not root.exists():
        return
    paths = [root, *sorted(root.rglob("*"))]
    for path in paths:
        try:
            os.chown(path, uid, uid)
        except OSError as exc:
            warn(f"could not chown {rel(path)} to {uid}:{uid}: {exc}")
            return
    try:
        root.chmod(0o700)
    except OSError:
        pass


def write_deploy_config(app_name: str, deploy: dict[str, Any], *, uid: int | None = None) -> Path:
    """Write app-local drain config (no webhook secret)."""
    ensure_deploy_runtime(app_name, uid=uid)
    payload = {
        "timeout": int(deploy.get("timeout") or DEFAULT_TIMEOUT),
        "workdir": str(deploy.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"),
        "command": list(deploy.get("command") or default_command(app_name)),
        "queue_policy": str(deploy.get("queue_policy") or DEFAULT_QUEUE_POLICY),
    }
    path = deploy_config_path(app_name)
    write_text_atomic(path, json.dumps(payload, indent=2) + "\n", mode=0o640)
    if uid is not None:
        own_deploy_runtime(app_name, uid)
    return path


def write_example_deploy_script(app_name: str, *, force: bool = False, uid: int | None = None) -> Path:
    path = deploy_script_path(app_name)
    if path.exists() and not force:
        if uid is not None:
            own_deploy_runtime(app_name, uid)
        return path
    ensure_deploy_runtime(app_name, uid=uid)
    content = f"""#!/bin/sh
# App deploy hook for {app_name}. Exit 0 success, {DEPLOY_SKIP_EXIT_CODE} skipped, other = failed.
set -eu
cd /home/{app_name}/{DOCROOT_NAME}
# git fetch --all --prune
# git reset --hard origin/main
# composer install --no-dev --optimize-autoloader
echo "deploy.sh for {app_name}: replace with your deploy steps" >&2
exit {DEPLOY_SKIP_EXIT_CODE}
"""
    write_text(path, content, 0o750)
    if uid is not None:
        own_deploy_runtime(app_name, uid)
    return path


def webhook_url(app: dict[str, Any]) -> str:
    if not deploy_enabled(app):
        die("Deployment is not enabled")
    domain = str(app.get("main_domain") or "").strip()
    if not domain:
        die("App has no main domain")
    return f"https://{domain}/_bento/deploy"


def deploy_cron_record(app_name: str, deploy: dict[str, Any], php_version: str) -> dict[str, Any]:
    """Managed minute drain job stored in stack crons."""
    from bento.utils.env import stack_env

    return {
        "app": app_name,
        "job_name": DEPLOY_CRON_JOB,
        "php_version": php_version,
        "php_service": f"{php_service_for(php_version)}-runner",
        "schedule": "* * * * *",
        # Explicit bento_APP so the drain works even if a nested shell drops env.
        "command": f"bento_APP={app_name} php /usr/local/bin/bento-deploy-drain",
        "workdir": str(deploy.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"),
        "output": "file",
        "timeout": int(deploy.get("timeout") or DEFAULT_TIMEOUT),
        "lock": "deploy",
        "timezone": stack_env().get("TZ", "UTC"),
        "managed_by": "deploy",
    }


def sync_deploy_cron(db: dict[str, Any], app_name: str) -> None:
    """Create or remove the managed drain cron for one app based on deploy.enabled."""
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        return
    key = deploy_cron_key(app_name)
    crons = db.setdefault("crons", {})
    if not deploy_enabled(app):
        crons.pop(key, None)
        return
    deploy = normalize_deploy(app_name, app.get("deploy"), php_version=str(app.get("php_version") or ""))
    app["deploy"] = deploy
    php_version = str(app.get("php_version") or "")
    crons[key] = deploy_cron_record(app_name, deploy, php_version)


def read_queue(app_name: str) -> dict[str, Any]:
    path = queue_path(app_name)
    if not path.exists():
        return empty_queue()
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return empty_queue()
    if not isinstance(data, dict):
        return empty_queue()
    jobs = data.get("jobs")
    if not isinstance(jobs, list):
        jobs = []
    return {"version": int(data.get("version") or 1), "jobs": jobs}


def latest_job(app_name: str) -> dict[str, Any] | None:
    jobs = [j for j in read_queue(app_name).get("jobs", []) if isinstance(j, dict)]
    if not jobs:
        return None

    def sort_key(job: dict[str, Any]) -> str:
        return str(job.get("finished_at") or job.get("started_at") or job.get("received_at") or "")

    return max(jobs, key=sort_key)


def history_jobs(app_name: str, *, limit: int = 20) -> list[dict[str, Any]]:
    jobs = [j for j in read_queue(app_name).get("jobs", []) if isinstance(j, dict)]
    jobs.sort(
        key=lambda job: str(job.get("finished_at") or job.get("started_at") or job.get("received_at") or ""),
        reverse=True,
    )
    return jobs[: max(1, limit)]


def host_home_exists() -> bool:
    return HOME_DIR.is_dir()
