"""Interactive MySQL backup restore workflow."""
from __future__ import annotations

import argparse
import re
import shlex

from bento.commands.db_commands import _list_final_backups, cmd_db_restore
from bento.commands.runtime_commands import print_plan, prompt_confirm, prompt_pick, prompt_text, prompt_validated
from bento.services.mysql import mysql_backup_dir
from bento.services.state import load_db
from bento.utils.env import default_mysql_service
from bento.utils.errors import die, info, warn
from bento.utils.paths import rel
from bento.utils.validation import DB_NAME_RE


def wizard_db_restore(*, default_service: str | None = None,
                      fixed_service: str | None = None,
                      app_name: str | None = None) -> None:
    """Interactively restore a database-only dump to a new or original database."""
    # Import here to share the service prompt without introducing a module cycle.
    from bento.commands.wizard_commands import wizard_mysql_service

    mysql_service = wizard_mysql_service(default_service, fixed_service)
    backup_dir = mysql_backup_dir(mysql_service)
    files = _list_final_backups(backup_dir)
    if not files:
        warn(f"No finalized backups in bento/{rel(backup_dir)}")
        path_text = prompt_text("Backup file path (or blank to cancel)", "", required=False)
        if not path_text.strip():
            return
        backup_file = path_text.strip()
        label = backup_file
    else:
        labels = []
        for path in files:
            st = path.stat()
            size_kb = max(1, st.st_size // 1024) if st.st_size else 0
            labels.append(f"{path.name} ({size_kb}K)")
        labels.append("Enter path manually…")
        choice = prompt_pick("Backup file", labels)
        if choice == "Enter path manually…":
            backup_file = prompt_text("Backup file path or filename under runtime/backups/<service>/")
            label = backup_file
        else:
            path = files[labels.index(choice)]
            backup_file = str(path)
            label = path.name

    database_choices: list[str] = []
    if app_name:
        app = load_db().get("apps", {}).get(app_name, {})
        database_choices = [str(name) for name in app.get("databases", [])]
    if database_choices:
        old_database = prompt_pick("Original database in this backup", database_choices)
    else:
        old_database = prompt_validated(
            "Original database name in this backup", re.compile(r"^[A-Za-z0-9_-]+$"), "database name"
        )

    destination = prompt_pick(
        "Restore destination",
        ["Restore to new database", "Restore to original database"],
        "Restore to new database",
    )
    new_suffix: str | None = None
    confirmation: str | None = None
    if destination == "Restore to new database":
        new_suffix = prompt_validated("New database suffix", DB_NAME_RE, "database suffix")
        target_database = f"{old_database}_{new_suffix}"
        risk = f"create and restore into new database {target_database}"
    else:
        target_database = old_database
        risk = f"DROP and recreate original database {old_database}"
        confirmation = prompt_text(
            f"Type the full original database name '{old_database}' to confirm"
        ).strip()
        if confirmation != old_database:
            die("Restore aborted: database name confirmation did not match")

    print_plan([
        f"restore {label} on {mysql_service}", risk,
        "streams dump into a freshly created destination (gzip auto-detected)",
    ])
    cmd_parts = [
        "./manage.py", "db", "restore", backup_file, "--database", old_database,
        "--mysql-service", mysql_service,
    ]
    if new_suffix:
        cmd_parts.extend(["--new-suffix", new_suffix])
    else:
        cmd_parts.extend(["--confirm-database", old_database])
    info("\nEquivalent command:")
    info("  " + " ".join(shlex.quote(part) for part in cmd_parts))
    if not prompt_confirm("Restore now?", False):
        return
    cmd_db_restore(argparse.Namespace(
        mysql_service=mysql_service,
        backup_file=backup_file,
        database=old_database,
        new_suffix=new_suffix,
        confirm_database=confirmation,
    ))
