"""Commands for adding durable MySQL runtime versions."""
from __future__ import annotations

import argparse
from typing import Any

from bento.services.mysql import mysql_root_option_file, render_mysql_root_option_files
from bento.services.mysql_versions import managed_mysql_versions, mysql_service_for, render_mysql_versions_compose
from bento.services.state import load_db, save_db, serialized_cron_state
from bento.ui.table import print_ascii_table as print_table
from bento.utils.env import default_mysql_service
from bento.utils.errors import info, warn
from bento.utils.paths import rel
from bento.utils.validation import MYSQL_VERSION_RE, validate


def add_parser(sub: Any) -> None:
    mysql = sub.add_parser("mysql", help="Manage MySQL runtime versions (removal is intentionally unsupported)")
    actions = mysql.add_subparsers(dest="mysql_command", required=True)
    listing = actions.add_parser("versions", aliases=["list"], help="List managed MySQL versions")
    listing.set_defaults(func=cmd_mysql_versions)
    add = actions.add_parser("add", help="Add a durable MySQL service and named volume")
    add.add_argument("version")
    add.set_defaults(func=cmd_mysql_add)


def cmd_mysql_versions(args: argparse.Namespace) -> None:
    db = load_db()
    default = default_mysql_service()
    print_table(
        [[version, mysql_service_for(version), "yes" if mysql_service_for(version) == default else ""] for version in managed_mysql_versions(db)],
        headers=["MYSQL", "SERVICE", "DEFAULT"],
    )


@serialized_cron_state
def cmd_mysql_add(args: argparse.Namespace) -> None:
    db = load_db()
    version = validate(args.version, MYSQL_VERSION_RE, "MySQL version")
    versions = set(managed_mysql_versions(db))
    if version in versions:
        info(f"MySQL {version} is already managed")
        return
    versions.add(version)
    db["mysql_versions"] = sorted(versions, key=lambda value: tuple(int(part) for part in value.split(".")))
    path = render_mysql_versions_compose(db)
    service = mysql_service_for(version)
    render_mysql_root_option_files(db=db)
    option_file = mysql_root_option_file(service)
    save_db(db)
    info(f"Added MySQL {version}; generated {path}")
    if option_file.is_file():
        info(f"Generated protected root option file: {rel(option_file)}")
    else:
        warn(
            f"Root password is unset; set {service.upper()}_ROOT_PASSWORD or MYSQL_ROOT_PASSWORD "
            "in .env, then run ./manage.py render before starting this service"
        )
    info(f"Start it with: ./dc up -d --build {service}")
    info(f"Its data is retained in the named volume {service}-data; CLI removal is intentionally unavailable")
