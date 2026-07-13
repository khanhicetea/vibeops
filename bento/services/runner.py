"""Versioned Supervisord runner rendering and lifecycle control."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, Iterable

from bento.os.fsutil import mkdir, write_text_atomic
from bento.os.process import run, service_running
from bento.services.compose import compose_command
from bento.services.php import php_runner_service_for, php_service_for
from bento.utils.env import default_php_version
from bento.utils.errors import die, info, warn
from bento.utils.paths import DOCROOT_NAME, GENERATED_NOTICE, RUNNER_RUNTIME_DIR, RenderContext
from bento.utils.validation import APP_NAME_RE, JOB_RE, PHP_VERSION_RE, validate, validate_cron_workdir


def runner_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.runner_dir_for(version)
    return RUNNER_RUNTIME_DIR / php_service_for(version)


def runner_programs_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.runner_programs_dir_for(version)
    return runner_dir_for(version) / "programs"


def runner_program_path(version: str, ctx: RenderContext | None = None) -> Path:
    return runner_programs_dir_for(version, ctx) / "bento.conf"


def cron_program_name(app_name: str) -> str:
    """Supervisord program name for an app's Supercronic child."""
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    return f"cron-{app_name}"


def worker_program_name(app_name: str, worker_name: str) -> str:
    """Supervisord program name for one named app worker."""
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    worker_name = validate(worker_name, JOB_RE, "worker name")
    return f"worker-{app_name}-{worker_name}"


def worker_targets(db: dict[str, Any], app_name: str, worker_name: str | None = None) -> list[str]:
    """Resolve flat Supervisord program names for worker control.

    Programs are intentionally ungrouped: membership changes then only start/stop
    the affected program on ``supervisorctl update``, instead of recycling an
    app process group. App-wide control expands names from state.
    """
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    if worker_name is not None:
        return [worker_program_name(app_name, worker_name)]
    names = [
        worker_program_name(str(worker["app"]), str(worker["name"]))
        for raw in db.get("workers", {}).values()
        if isinstance(raw, dict)
        for worker in (normalize_worker(raw),)
        if worker["app"] == app_name
    ]
    return sorted(names)


def _supervisor_command(argv: Iterable[str]) -> str:
    values = list(argv)
    if not values or any(not isinstance(arg, str) or not arg or "\x00" in arg or "\n" in arg or "\r" in arg for arg in values):
        die("Worker command arguments must be non-empty strings without NUL/newlines")
    # Supervisor performs %(...) interpolation even inside command values.
    return shlex.join(values).replace("%", "%%")


def normalize_worker(worker: dict[str, Any]) -> dict[str, Any]:
    app_name = validate(str(worker.get("app", "")), APP_NAME_RE, "app_name")
    name = validate(str(worker.get("name", "")), JOB_RE, "worker name")
    version = validate(str(worker.get("php_version") or default_php_version()), PHP_VERSION_RE, "PHP version")
    workdir = validate_cron_workdir(app_name, str(worker.get("workdir") or f"/home/{app_name}/{DOCROOT_NAME}"))
    command = worker.get("command")
    if not isinstance(command, list):
        die(f"Worker {app_name}/{name} command must be an argument list")
    command = [str(arg) for arg in command]
    _supervisor_command(command)
    try:
        stop_timeout = int(worker.get("stop_timeout") or 120)
    except (TypeError, ValueError):
        die(f"Invalid stop timeout for worker {app_name}/{name}")
    if stop_timeout < 1 or stop_timeout > 86400:
        die("Worker stop timeout must be between 1 and 86400 seconds")
    return {
        **worker,
        "app": app_name,
        "name": name,
        "php_version": version,
        "workdir": workdir,
        "command": command,
        "stop_timeout": stop_timeout,
        "enabled": bool(worker.get("enabled", True)),
    }


def _common_program_lines(app_name: str, workdir: str) -> list[str]:
    return [
        f"user={app_name}",
        f"directory={workdir}",
        "umask=0027",
        (
            f'environment=HOME="/home/{app_name}",USER="{app_name}",LOGNAME="{app_name}",'
            f'COMPOSER_HOME="/home/{app_name}/.composer",bento_APP="{app_name}"'
        ),
        "stdout_logfile=/dev/fd/1",
        "stdout_logfile_maxbytes=0",
        "stdout_logfile_backups=0",
        "redirect_stderr=true",
    ]


def render_runner_programs(db: dict[str, Any], version: str, ctx: RenderContext | None = None) -> Path:
    version = validate(version, PHP_VERSION_RE, "PHP version")
    programs_dir = runner_programs_dir_for(version, ctx)
    mkdir(programs_dir)
    path = runner_program_path(version, ctx)
    lines = [
        f"; {GENERATED_NOTICE}",
        f"; PHP {version} runner programs",
        "",
        "[program:system-cron]",
        "command=/usr/local/bin/php-supercronic /usr/local/etc/php/cron.d/system.cron",
        "autostart=true",
        "autorestart=true",
        "startsecs=2",
        "startretries=10",
        "stopsignal=TERM",
        "stopasgroup=true",
        "killasgroup=true",
        "stopwaitsecs=30",
        "stdout_logfile=/dev/fd/1",
        "stdout_logfile_maxbytes=0",
        "stdout_logfile_backups=0",
        "redirect_stderr=true",
        "",
    ]

    # Flat programs (no [group:app-*]): supervisorctl update then only adds/
    # restarts programs whose individual config changed, so adding a worker does
    # not recycle the app's cron scheduler or sibling workers.
    cron_apps = sorted({
        validate(str(cron.get("app", "")), APP_NAME_RE, "app_name")
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict) and str(cron.get("php_version") or default_php_version()) == version
    })
    for app_name in cron_apps:
        program = cron_program_name(app_name)
        lines.extend([
            f"[program:{program}]",
            f"command=/usr/local/bin/php-supercronic /usr/local/etc/php/cron.d/apps/{app_name}.cron",
            *_common_program_lines(app_name, f"/home/{app_name}/{DOCROOT_NAME}"),
            "autostart=true",
            "autorestart=true",
            "startsecs=2",
            "startretries=10",
            "stopsignal=TERM",
            "stopasgroup=true",
            "killasgroup=true",
            "stopwaitsecs=30",
            "",
        ])

    for key, raw_worker in sorted(db.get("workers", {}).items()):
        if not isinstance(raw_worker, dict):
            continue
        worker = normalize_worker(raw_worker)
        if worker["php_version"] != version or not worker["enabled"]:
            continue
        app_name = str(worker["app"])
        name = str(worker["name"])
        program = worker_program_name(app_name, name)
        lines.extend([
            f"[program:{program}]",
            f"command={_supervisor_command(worker['command'])}",
            *_common_program_lines(app_name, str(worker["workdir"])),
            "autostart=true",
            "autorestart=true",
            "startsecs=5",
            "startretries=10",
            "stopsignal=TERM",
            "stopasgroup=true",
            "killasgroup=true",
            f"stopwaitsecs={worker['stop_timeout']}",
            "",
        ])

    write_text_atomic(path, "\n".join(lines))
    return path


def runner_versions(db: dict[str, Any], available: Iterable[str]) -> set[str]:
    versions = set(available)
    versions.update(
        str(app.get("php_version") or default_php_version())
        for app in db.get("apps", {}).values()
        if isinstance(app, dict)
    )
    versions.update(
        str(worker.get("php_version") or default_php_version())
        for worker in db.get("workers", {}).values()
        if isinstance(worker, dict)
    )
    return versions


def runner_app_names(db: dict[str, Any], version: str) -> list[str]:
    return sorted(
        app_name
        for app_name, app in db.get("apps", {}).items()
        if isinstance(app, dict) and str(app.get("php_version") or default_php_version()) == version
    )


def validate_runner(db: dict[str, Any], version: str) -> None:
    runner = php_runner_service_for(version)
    fallback = php_service_for(version)
    service = runner if service_running(runner) else fallback if service_running(fallback) else None
    if service is None:
        warn(f"Could not validate {runner}: neither {runner} nor {fallback} is running")
        return
    apps = runner_app_names(db, version)
    if apps:
        run(compose_command("exec", "-T", service, "php-identity-sync", *apps))
    run(compose_command("exec", "-T", service, "supercronic", "-no-reap", "-test", "/usr/local/etc/php/cron.d/system.cron"))
    cron_apps = sorted({
        str(cron.get("app"))
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict) and str(cron.get("php_version") or default_php_version()) == version
    })
    for app_name in cron_apps:
        run(compose_command("exec", "-T", service, "supercronic", "-no-reap", "-test", f"/usr/local/etc/php/cron.d/apps/{app_name}.cron"))
    if service == runner:
        # Supervisor has no parse-only mode. `reread` parses the complete
        # promoted configuration without starting/stopping child processes;
        # `update` happens only after every validator succeeds.
        run(compose_command("exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf", "reread"))
    else:
        warn(f"{runner} is stopped; Supervisor config will be parsed on startup")


def reconcile_runner(db: dict[str, Any], version: str) -> None:
    service = php_runner_service_for(version)
    if not service_running(service):
        info(f"{service} is not running; start it to load cron and worker processes")
        return
    run(compose_command("exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf", "reread"))
    run(compose_command("exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf", "update"))
    # Crontab contents are external to Supervisor config, so reload schedulers
    # even when reread reports no program-level changes.
    run(compose_command("exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf", "signal", "USR2", "system-cron"))
    cron_apps = sorted({
        str(cron.get("app"))
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict) and str(cron.get("php_version") or default_php_version()) == version
    })
    for app_name in cron_apps:
        result = run(
            compose_command(
                "exec", "-T", service, "supervisorctl", "-c", "/etc/bento/supervisord.conf",
                "signal", "USR2", cron_program_name(app_name),
            ),
            check=False,
            capture=True,
        )
        if result.returncode != 0:
            warn(f"Could not signal {cron_program_name(app_name)} after runner update")
    info(f"Reconciled {service} cron and worker processes")
