"""MySQL diagnostics and interactive version management."""
from __future__ import annotations

import argparse
import re
import shlex

from bento.commands.db_commands import cmd_db_shell, _require_mysql_service
from bento.commands.mysql_version_commands import cmd_mysql_add, cmd_mysql_versions
from bento.commands.runtime_commands import (
    prompt_choice,
    prompt_confirm,
    prompt_pick,
    prompt_validated,
    print_plan,
)
from bento.services.mysql import mysql_root_exec_sql
from bento.services.mysql_versions import managed_mysql_versions, mysql_service_for
from bento.services.state import load_db
from bento.ui.table import print_ascii_table as print_table
from bento.ui.decorations import print_heading
from bento.utils.env import default_mysql_service
from bento.utils.errors import info, warn


def _mysql_tabular_rows(sql: str, *, service: str) -> tuple[list[str], list[list[str]]]:
    """Run a trusted administrative query and parse mysql batch TSV output."""
    service = _require_mysql_service(service)
    cp = mysql_root_exec_sql(sql, service=service)
    lines = (cp.stdout or "").splitlines()
    if not lines:
        return [], []
    headers = lines[0].split("\t")
    rows = [line.split("\t", maxsplit=max(0, len(headers) - 1)) for line in lines[1:] if line]
    return headers, rows


def _human_bytes(raw: str) -> str:
    size = float(raw or 0)
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TiB"


def cmd_db_stats(args: argparse.Namespace) -> None:
    """Show per-database table counts and allocated data/index size."""
    _headers, rows = _mysql_tabular_rows(
        """
SELECT s.SCHEMA_NAME AS DATABASE_NAME,
       COUNT(t.TABLE_NAME) AS TABLES,
       COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS SIZE_BYTES
FROM information_schema.SCHEMATA AS s
LEFT JOIN information_schema.TABLES AS t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
WHERE s.SCHEMA_NAME NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
GROUP BY s.SCHEMA_NAME
ORDER BY SIZE_BYTES DESC, s.SCHEMA_NAME;
""",
        service=args.mysql_service,
    )
    if not rows:
        info("(no user databases)")
        return
    print_table([[row[0], row[1], _human_bytes(row[2])] for row in rows], headers=["DATABASE", "TABLES", "SIZE"])


def cmd_db_process_list(args: argparse.Namespace) -> None:
    """Show current server sessions, excluding this short-lived query."""
    headers, rows = _mysql_tabular_rows(
        """
SELECT ID, USER, HOST, COALESCE(DB, '-') AS DB, COMMAND, TIME,
       COALESCE(STATE, '-') AS STATE,
       COALESCE(REPLACE(REPLACE(REPLACE(LEFT(INFO, 200), CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), '-') AS INFO
FROM information_schema.PROCESSLIST
WHERE ID <> CONNECTION_ID()
ORDER BY TIME DESC, ID;
""",
        service=args.mysql_service,
    )
    if not rows:
        info("(no other MySQL processes)")
        return
    print_table(rows, headers=headers)


def wizard_select_mysql_service() -> str:
    db = load_db()
    default = default_mysql_service()
    services = [(version, mysql_service_for(version)) for version in managed_mysql_versions(db)]
    labels = [f"MySQL {version} ({service}{', default' if service == default else ''})" for version, service in services]
    default_label = next((label for label, item in zip(labels, services) if item[1] == default), labels[0])
    selected = prompt_pick("MySQL version", labels, default_label)
    return services[labels.index(selected)][1]


def wizard_manage_mysql_versions() -> None:
    actions = ["Open MySQL shell", "Database sizes", "Process list", "Add version"]
    while True:
        print_heading("Managed MySQL versions", writer=info)
        cmd_mysql_versions(argparse.Namespace())
        action = prompt_choice("MySQL version action", actions)
        if action == "Back":
            return
        if action == "Add version":
            version = prompt_validated("MySQL version", re.compile(r"^[0-9]+\.[0-9]+$"), "MySQL version", "8.4")
            print_plan([
                f"add MySQL {version}",
                "create a durable named data volume",
                "generate its Compose service and protected root option file",
            ])
            if prompt_confirm("Continue?", True):
                cmd_mysql_add(argparse.Namespace(version=version))
            continue

        service = wizard_select_mysql_service()
        if action == "Open MySQL shell":
            info(f"Equivalent command: ./manage.py db shell --mysql-service {shlex.quote(service)}")
            try:
                cmd_db_shell(argparse.Namespace(user=None, mysql_service=service))
            except SystemExit as exc:
                if exc.code not in (None, 0):
                    warn(f"MySQL shell exited with status {exc.code}")
        elif action == "Database sizes":
            info(f"Equivalent command: ./manage.py db stats --mysql-service {shlex.quote(service)}")
            cmd_db_stats(argparse.Namespace(mysql_service=service))
        else:
            info(f"Equivalent command: ./manage.py db process-list --mysql-service {shlex.quote(service)}")
            cmd_db_process_list(argparse.Namespace(mysql_service=service))
