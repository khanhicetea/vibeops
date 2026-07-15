"""Host-triggered stack maintenance jobs and cron registration."""
from __future__ import annotations

import argparse
import shlex

from bento.commands.cron_commands import validate_schedule
from bento.services.compose import compose_prefix
from bento.utils.errors import die, info
from bento.utils.paths import ROOT
from bento.os.process import command_exists, docker_available, run, service_running

_CRON_BEGIN = "# BEGIN bento maintenance"
_CRON_END = "# END bento maintenance"
_DEFAULT_SCHEDULE = "17 3 * * *"


def run_maintenance(*, force: bool = False) -> None:
    """Run all current stack maintenance jobs inside their owning containers."""
    if not docker_available():
        die("docker is required to run stack maintenance")
    if not service_running("nginx"):
        die("nginx must be running to run stack maintenance")

    command = [
        *compose_prefix(),
        "exec",
        "-T",
        "nginx",
        "logrotate",
        "--state",
        "/var/log/nginx/.bento-logrotate.status",
    ]
    if force:
        command.append("--force")
    command.append("/etc/logrotate.d/bento-nginx")
    run(command)
    info("Maintenance completed")


def _cron_command() -> str:
    root = str(ROOT.resolve())
    manage = str((ROOT / "manage.py").resolve())
    return f"cd {shlex.quote(root)} && {shlex.quote(manage)} maintenance"


def setup_cron(schedule: str) -> None:
    schedule = validate_schedule(schedule)
    if len(schedule.split()) != 5:
        die("Host maintenance cron schedule must have exactly 5 fields")
    if "#" in schedule:
        die("Host maintenance cron schedule cannot contain comments")
    if not command_exists("crontab"):
        die("crontab is required to register host maintenance")

    current = run(["crontab", "-l"], check=False, capture=True)
    if current.returncode not in {0, 1}:
        detail = (current.stderr or current.stdout or "").strip()
        die("Unable to read the current crontab" + (f": {detail}" if detail else ""))

    lines = (current.stdout or "").splitlines()
    begin_indexes = [index for index, line in enumerate(lines) if line == _CRON_BEGIN]
    end_indexes = [index for index, line in enumerate(lines) if line == _CRON_END]
    if len(begin_indexes) != len(end_indexes) or len(begin_indexes) > 1:
        die("Current crontab has a malformed bento maintenance block; repair it manually")
    if begin_indexes:
        begin, end = begin_indexes[0], end_indexes[0]
        if end < begin:
            die("Current crontab has a malformed bento maintenance block; repair it manually")
        retained = [*lines[:begin], *lines[end + 1:]]
    else:
        retained = lines
    while retained and not retained[-1].strip():
        retained.pop()
    if retained:
        retained.append("")
    retained.extend([_CRON_BEGIN, f"{schedule} {_cron_command()}", _CRON_END])
    run(["crontab", "-"], input_text="\n".join(retained) + "\n")
    info(f"Installed host cron: {schedule} {_cron_command()}")


def cmd_maintenance(args: argparse.Namespace) -> None:
    action = getattr(args, "maintenance_action", None) or "run"
    if action == "setup-cron":
        setup_cron(str(args.schedule))
        return
    run_maintenance(force=bool(getattr(args, "force", False)))


def add_parser(subparsers: argparse._SubParsersAction) -> None:
    maintenance = subparsers.add_parser(
        "maintenance",
        help="Run stack maintenance jobs or register them in host cron",
    )
    actions = maintenance.add_subparsers(dest="maintenance_action")
    run_now = actions.add_parser("run", help="Run maintenance jobs now")
    run_now.add_argument("--force", action="store_true", help="Force log rotation regardless of size")
    run_now.set_defaults(func=cmd_maintenance)
    setup = actions.add_parser("setup-cron", help="Register ./manage.py maintenance in the current user's crontab")
    setup.add_argument("--schedule", default=_DEFAULT_SCHEDULE, help="Five-field host cron schedule")
    setup.set_defaults(func=cmd_maintenance)
    maintenance.add_argument("--force", action="store_true", help="Force log rotation regardless of size")
    maintenance.set_defaults(func=cmd_maintenance)
