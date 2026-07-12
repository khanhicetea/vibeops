"""Per-app Supercronic rendering and runner reload helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from vibeops.os.fsutil import mkdir, write_text_atomic
from vibeops.os.process import run, service_running
from vibeops.services.compose import compose_command
from vibeops.services.php import php_service_for, php_runner_service_for
from vibeops.utils.errors import info, warn
from vibeops.utils.paths import CRON_RUNTIME_DIR, GENERATED_NOTICE, RenderContext
from vibeops.utils.validation import APP_NAME_RE, validate


def cron_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.cron_dir_for(version)
    return CRON_RUNTIME_DIR / php_service_for(version)


def cron_jobs_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    return cron_dir_for(version, ctx) / "jobs"


def cron_apps_dir_for(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.cron_apps_dir_for(version)
    return cron_dir_for(version) / "apps"


def system_crontab_for(version: str, ctx: RenderContext | None = None) -> Path:
    return cron_dir_for(version, ctx) / "system.cron"


def app_crontab_for(version: str, app_name: str, ctx: RenderContext | None = None) -> Path:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    return cron_apps_dir_for(version, ctx) / f"{app_name}.cron"


def _app_from_job_file(path: Path) -> str:
    for line in path.read_text().splitlines():
        if line.startswith("# App: "):
            return validate(line.removeprefix("# App: ").strip(), APP_NAME_RE, "app_name")
    raise ValueError(f"Generated cron job has no app marker: {path}")


def rebuild_supercronic_crontab(php_version: str, ctx: RenderContext | None = None) -> Path:
    """Rebuild root maintenance and one merged Supercronic file per app.

    The historical function name remains for compatibility. It now returns the
    system maintenance crontab rather than a shared, root-owned app crontab.
    """
    cron_dir = cron_dir_for(php_version, ctx)
    jobs_dir = cron_jobs_dir_for(php_version, ctx)
    apps_dir = cron_apps_dir_for(php_version, ctx)
    mkdir(cron_dir)
    mkdir(jobs_dir)
    mkdir(apps_dir)

    runner_service = php_runner_service_for(php_version)
    logrotate_config = cron_dir / ".logrotate.conf"
    write_text_atomic(logrotate_config, f"""# {GENERATED_NOTICE}
/home/*/logs/cron-{runner_service}-*.log /home/*/logs/fpm-php-{php_version}.error.log /home/*/logs/fpm-php-{php_version}.slow.log {{
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

    system = system_crontab_for(php_version, ctx)
    write_text_atomic(system, f"""# {GENERATED_NOTICE}
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Stack maintenance stays root-owned; app schedules run in per-app schedulers.
17 3 * * * /usr/sbin/logrotate -s /var/lib/logrotate/vibeops-{runner_service}.status /usr/local/etc/php/cron.d/.logrotate.conf
""")

    grouped: dict[str, list[Path]] = {}
    for job_file in sorted(jobs_dir.glob("*.cron")):
        grouped.setdefault(_app_from_job_file(job_file), []).append(job_file)

    expected: set[Path] = set()
    for app_name, files in sorted(grouped.items()):
        app_path = app_crontab_for(php_version, app_name, ctx)
        expected.add(app_path)
        lines = [
            f"# {GENERATED_NOTICE}",
            f"# App scheduler: {app_name}",
            "SHELL=/bin/sh",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "",
        ]
        for job_file in files:
            lines.append(f"# Source: {job_file.name}")
            lines.append(job_file.read_text().rstrip("\n"))
            lines.append("")
        write_text_atomic(app_path, "\n".join(lines) + "\n")

    # Direct cron mutations also use this helper outside a staging directory.
    for stale in apps_dir.glob("*.cron"):
        if stale not in expected and stale.is_file() and GENERATED_NOTICE in stale.read_text()[:512]:
            stale.unlink()
    return system


def app_cron_names(version: str, ctx: RenderContext | None = None) -> list[str]:
    return sorted(path.stem for path in cron_apps_dir_for(version, ctx).glob("*.cron"))


def cron_reload(service: str, usernames: Iterable[str] = ()) -> None:
    """Validate and signal per-app Supercronic children through Supervisord."""
    if not service_running(service):
        info(f"{service} is not running; start it to load cron jobs.")
        return

    names = sorted(set(usernames))
    suffix = service.removesuffix("-runner").removeprefix("php")
    version_dir = CRON_RUNTIME_DIR / f"php{suffix}"
    if not names:
        names = sorted(path.stem for path in (version_dir / "apps").glob("*.cron"))
    if names:
        run(compose_command("exec", "-T", service, "php-identity-sync", *names))
    for app_name in names:
        validate(app_name, APP_NAME_RE, "app_name")
        container_path = f"/usr/local/etc/php/cron.d/apps/{app_name}.cron"
        run(compose_command("exec", "-T", service, "supercronic", "-test", container_path))
        target = f"app-{app_name}:cron-{app_name}"
        result = run(
            compose_command("exec", "-T", service, "supervisorctl", "-c", "/etc/vibeops/supervisord.conf", "signal", "USR2", target),
            check=False,
            capture=True,
        )
        if result.returncode == 0:
            info(f"Validated and reloaded {target}")
        else:
            warn(f"{target} is not running yet; reconcile {service} with supervisorctl update")
