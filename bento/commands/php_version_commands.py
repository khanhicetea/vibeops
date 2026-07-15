"""Commands for managing installed PHP runtime versions."""
from __future__ import annotations

import argparse
from typing import Any

from bento.services.php_versions import managed_php_versions, render_php_versions_compose
from bento.services.state import load_db, save_db, serialized_render
from bento.ui.table import print_ascii_table as print_table
from bento.utils.env import default_php_version
from bento.utils.errors import die, info
from bento.utils.validation import PHP_VERSION_RE, validate


def add_parser(sub: Any) -> None:
    php = sub.add_parser("php", help="Manage PHP runtime versions")
    actions = php.add_subparsers(dest="php_command", required=True)
    listing = actions.add_parser("versions", aliases=["list"], help="List managed PHP versions")
    listing.set_defaults(func=cmd_php_versions)
    add = actions.add_parser("add", help="Add a PHP FPM/runner/CLI service set")
    add.add_argument("version")
    add.set_defaults(func=cmd_php_add)
    remove = actions.add_parser("remove", aliases=["delete"], help="Remove an unused PHP service set")
    remove.add_argument("version")
    remove.set_defaults(func=cmd_php_remove)


def cmd_php_versions(args: argparse.Namespace) -> None:
    db = load_db()
    default = default_php_version()
    print_table([[v, "yes" if v == default else ""] for v in managed_php_versions(db)], headers=["PHP", "DEFAULT"])


@serialized_render
def cmd_php_add(args: argparse.Namespace) -> None:
    db = load_db()
    version = validate(args.version, PHP_VERSION_RE, "PHP version")
    versions = set(managed_php_versions(db))
    if version in versions:
        info(f"PHP {version} is already managed")
        return
    versions.add(version)
    db["php_versions"] = sorted(versions)
    path = render_php_versions_compose(db)
    save_db(db)
    info(f"Added PHP {version}; generated {path.relative_to(path.parents[1])}")
    info(f"Build/start it with: ./dc up -d --build php{version.replace('.', '')} php{version.replace('.', '')}-runner")


@serialized_render
def cmd_php_remove(args: argparse.Namespace) -> None:
    db = load_db()
    version = validate(args.version, PHP_VERSION_RE, "PHP version")
    versions = set(managed_php_versions(db))
    if version not in versions:
        die(f"PHP {version} is not managed")
    if version == default_php_version():
        die(f"Cannot remove default PHP {version}; change DEFAULT_PHP_VERSION first")
    users = sorted(name for name, app in db.get("apps", {}).items() if isinstance(app, dict) and str(app.get("php_version")) == version)
    if users:
        die(f"Cannot remove PHP {version}; used by app(s): {', '.join(users)}")
    versions.remove(version)
    if not versions:
        die("Cannot remove the last PHP version")
    db["php_versions"] = sorted(versions)
    path = render_php_versions_compose(db)
    save_db(db)
    info(f"Removed PHP {version} from {path}")
    info(f"Remove stopped containers with: ./dc up -d --remove-orphans")
