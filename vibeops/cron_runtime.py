"""Cron path helpers, aggregate crontab rebuild, and scheduler reload."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from vibeops.errors import info, warn
from vibeops.fsutil import mkdir, write_text_atomic
from vibeops.paths import CRON_RUNTIME_DIR, RenderContext
from vibeops.php import php_cron_service_for, php_service_for
from vibeops.process import run, service_running

def cron_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.cron_dir_for(version)
    return CRON_RUNTIME_DIR / php_service_for(version)


def cron_jobs_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    return cron_dir_for(version, ctx) / "jobs"


def rebuild_supercronic_crontab(php_version: str, ctx: RenderContext | None = None) -> Path:
    cron_dir = cron_dir_for(php_version, ctx)
    mkdir(cron_dir)
    combined = cron_dir / ".supercronic.cron"
    logrotate_config = cron_dir / ".logrotate.conf"
    php_cron_service = php_cron_service_for(php_version)
    write_text_atomic(logrotate_config, f"""/home/*/logs/cron-{php_cron_service}-*.log /home/*/logs/fpm-php-{php_version}.error.log /home/*/logs/fpm-php-{php_version}.slow.log {{
    daily
    rotate 14
    dateext
    dateformat -%Y-%m-%d
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}}
""")
    job_files = sorted(cron_jobs_dir_for(php_version, ctx).glob("*.cron"))
    lines = [
        "SHELL=/bin/sh",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "",
        "# Always rotate app-owned cron output and FPM logs into dated archives.",
        f"17 3 * * * /usr/sbin/logrotate -s /var/lib/logrotate/vibeops-{php_cron_service}.status /usr/local/etc/php/cron.d/.logrotate.conf",
        "",
    ]
    for cron_file in job_files:
        lines.append(f"# /usr/local/etc/php/cron.d/{cron_file.name}")
        lines.append(cron_file.read_text().rstrip("\n"))
        lines.append("")
    write_text_atomic(combined, "\n".join(lines) + "\n")
    return combined


def cron_reload(service: str, usernames: Iterable[str] = ()) -> None:
    crontab = "/usr/local/etc/php/cron.d/.supercronic.cron"
    if service_running(service):
        run(["docker", "compose", "exec", "-T", service, "php-identity-sync", *usernames])
        run(["docker", "compose", "exec", "-T", service, "supercronic", "-test", crontab])
        run(["docker", "compose", "kill", "-s", "USR2", service])
        info(f"Validated and reloaded {service} cron with SIGUSR2")
        return

    # The matching FPM image has the same binary and read-only cron mount, so it
    # can still provide authoritative validation while the scheduler is stopped.
    php_service = service.removesuffix("-cron")
    if service_running(php_service):
        run(["docker", "compose", "exec", "-T", php_service, "supercronic", "-test", crontab])
        info(f"Validated {service} crontab using {php_service}")
    else:
        warn(f"could not run supercronic -test because {service} and {php_service} are stopped; scheduler startup will validate it")
    info(f"{service} is not running; start it to load this cron job.")
