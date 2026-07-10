"""MySQL database lifecycle and backup commands."""
from __future__ import annotations

import argparse
import datetime as _dt
import re
import shlex
import subprocess
import sys
from pathlib import Path

from vibeops.helpers import *  # noqa: F403


def _require_mysql_service(service: str) -> str:
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    if not service_running(service):
        die(f"{service} service is not running")
    if not mysql_root_password(stack_env(), service):
        die(f"Missing root password for {service}; set {service.upper()}_ROOT_PASSWORD or MYSQL_ROOT_PASSWORD in .env")
    return service


def _stamp() -> str:
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def _list_user_databases(service: str, *, app_name: str | None = None) -> list[str]:
    cp = mysql_root_exec_sql("SHOW DATABASES;", service=service)
    names: list[str] = []
    for line in (cp.stdout or "").splitlines():
        name = line.strip()
        if not name or name in SYSTEM_MYSQL_DATABASES or name == "Database":
            continue
        if app_name and not name.startswith(f"{app_name}_"):
            continue
        names.append(name)
    return names


def mysql_root_dump(mysqldump_args: list[str], *, service: str, output_path: Path) -> None:
    """Run mysqldump inside the mysql container; write stdout to a host path."""
    service = _require_mysql_service(service)
    mkdir(output_path.parent, 0o700)
    quoted = " ".join(shlex.quote(a) for a in mysqldump_args)
    cmd = [
        "docker", "compose", "exec", "-T", service,
        "sh", "-lc",
        f'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --events --default-character-set=utf8mb4 {quoted}',
    ]
    with output_path.open("w", encoding="utf-8") as fh:
        cp = subprocess.run(cmd, cwd=str(ROOT), stdout=fh, stderr=subprocess.PIPE, text=True)
    if cp.returncode != 0:
        if output_path.exists() and output_path.stat().st_size == 0:
            output_path.unlink(missing_ok=True)
        err = (cp.stderr or "").strip()
        die(f"mysqldump on {service} failed (exit {cp.returncode})" + (f": {err}" if err else ""))


def cmd_db_list(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    app_name = validate(args.app, APP_NAME_RE, "app_name") if args.app else None
    names = _list_user_databases(service, app_name=app_name)
    if not names:
        info("(no databases)")
        return
    for name in names:
        info(name)


def cmd_db_create(args: argparse.Namespace) -> None:
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    suffix = validate(args.db_suffix, DB_NAME_RE, "database suffix")
    service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    db_full_name = ensure_mysql_database(app_name, suffix, service)
    db = load_db()
    app = db.get("apps", {}).get(app_name)
    if isinstance(app, dict):
        if db_full_name not in app.setdefault("databases", []):
            app["databases"].append(db_full_name)
        app.setdefault("database_services", {})[db_full_name] = service
        upsert_timestamp(app)
        save_db(db)


def cmd_db_user_reset(args: argparse.Namespace) -> None:
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    password = args.password or generate_password()
    created, cred_path = create_mysql_user(app_name, password, service)
    if not created:
        die(f"Could not reset MySQL user for {app_name} on {service}")
    db = load_db()
    app = db.get("apps", {}).get(app_name)
    if isinstance(app, dict):
        apply_app_mysql_metadata(app, app_name, service, cred_path)
        app["mysql_user"] = True
        upsert_timestamp(app)
        save_db(db)


def cmd_db_shell(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    if args.user:
        username = validate(args.user, APP_NAME_RE, "app_name")
        cred_path = HOME_DIR / username / ".credentials" / f"{service}.env"
        creds = parse_env_file(cred_path)
        password = creds.get("MYSQL_PASSWORD") or creds.get("DB_PASSWORD")
        if not password:
            die(f"Missing credentials for {username} on {service}: vibeops/{rel(cred_path)}")
        # Password is passed only into the container shell env for this exec, not as host mysql argv.
        # Docker API still receives it; acceptable for interactive DX. Prefer root shell for ops.
        cp = subprocess.run(
            [
                "docker", "compose", "exec",
                "-e", f"MYSQL_USER={username}",
                "-e", f"MYSQL_PWD={password}",
                service,
                "sh", "-lc",
                'mysql -u"$MYSQL_USER" -p"$MYSQL_PWD"',
            ],
            cwd=str(ROOT),
            check=False,
        )
        raise SystemExit(cp.returncode)
    cp = subprocess.run(
        [
            "docker", "compose", "exec", service,
            "sh", "-lc",
            'mysql -uroot -p"$MYSQL_ROOT_PASSWORD"',
        ],
        cwd=str(ROOT),
        check=False,
    )
    raise SystemExit(cp.returncode)


def cmd_db_backup(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    backup_dir = mysql_backup_dir(service)
    mkdir(backup_dir, 0o700)
    stamp = _stamp()
    targets: list[str] = []

    if args.database:
        targets = [validate(args.database, re.compile(r"^[A-Za-z0-9_-]+$"), "database name")]
    elif args.app:
        app_name = validate(args.app, APP_NAME_RE, "app_name")
        targets = _list_user_databases(service, app_name=app_name)
        if not targets:
            die(f"No databases found for app {app_name} on {service}")
    else:
        targets = _list_user_databases(service)
        if not targets:
            die(f"No user databases found on {service}")

    written: list[Path] = []
    for db_name in targets:
        out = backup_dir / f"{stamp}_{db_name}.sql"
        mysql_root_dump(["--databases", db_name], service=service, output_path=out)
        written.append(out)
        info(f"Wrote vibeops/{rel(out)}")

    if args.keep is not None and args.keep >= 0:
        _apply_retention(backup_dir, keep=args.keep)

    if not written:
        die("No backups written")


def _apply_retention(backup_dir: Path, *, keep: int) -> None:
    files = sorted(
        [p for p in backup_dir.glob("*.sql") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in files[keep:]:
        path.unlink(missing_ok=True)
        info(f"Removed old backup vibeops/{rel(path)}")


def cmd_db_list_backups(args: argparse.Namespace) -> None:
    service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    backup_dir = mysql_backup_dir(service)
    files = sorted(
        [p for p in backup_dir.glob("*.sql") if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        info(f"No backups in vibeops/{rel(backup_dir)}")
        return
    for path in files:
        st = path.stat()
        mtime = _dt.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        size_kb = max(1, st.st_size // 1024) if st.st_size else 0
        info(f"{mtime}\t{size_kb:>8}K\tvibeops/{rel(path)}")


def _resolve_backup_path(raw: str, service: str) -> Path:
    path = Path(raw)
    if path.is_file():
        return path.resolve()
    candidate = mysql_backup_dir(service) / raw
    if candidate.is_file():
        return candidate.resolve()
    # Also allow relative path without vibeops/ prefix
    alt = ROOT / raw
    if alt.is_file():
        return alt.resolve()
    die(f"Backup file not found: {raw}")


def cmd_db_restore(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    path = _resolve_backup_path(args.backup_file, service)
    if not args.yes:
        if sys.stdin.isatty():
            answer = input(f"Restore {rel(path)} into {service}? This may overwrite objects. Type 'yes' to continue: ").strip().lower()
            if answer != "yes":
                die("Restore aborted")
        else:
            die("Restore requires --yes when stdin is not a TTY")

    sql = path.read_text(encoding="utf-8")
    if not sql.strip():
        die(f"Backup file is empty: vibeops/{rel(path)}")
    warn(f"Restoring vibeops/{rel(path)} into {service} (objects in the dump may be overwritten)")
    mysql_root_exec_sql(sql, service=service)
    info(f"Restored vibeops/{rel(path)} into {service}")
