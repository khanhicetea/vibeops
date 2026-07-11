"""MySQL database lifecycle and backup commands."""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import secrets
import shlex
import subprocess
import sys
from pathlib import Path

from vibeops.compose import compose_command
from vibeops.helpers import *  # noqa: F403


def _require_mysql_service(service: str) -> str:
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    if not service_running(service):
        die(f"{service} service is not running")
    option_file = mysql_root_option_file(service)
    if not option_file.is_file():
        die(f"Missing protected MySQL option file vibeops/{rel(option_file)}; run ./manage.py render")
    return service


def _stamp() -> str:
    """Human-sortable backup batch stamp with microsecond precision."""
    return _dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")


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


def _reserve_backup_path(backup_dir: Path, stamp: str, db_name: str) -> Path:
    """Return a final ``.sql`` path that does not yet exist (never truncate)."""
    primary = backup_dir / f"{stamp}_{db_name}.sql"
    if not primary.exists():
        return primary
    for _ in range(64):
        candidate = backup_dir / f"{stamp}_{db_name}_{secrets.token_hex(3)}.sql"
        if not candidate.exists():
            return candidate
    die(f"Could not reserve a unique backup name for {db_name} under vibeops/{rel(backup_dir)}")


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _open_private_partial(path: Path):
    """Create an exclusive mode-600 partial file (not matched by ``*.sql``)."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(str(path), flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    return os.fdopen(fd, "wb")


def mysql_root_dump(mysqldump_args: list[str], *, service: str, output_path: Path) -> None:
    """Run mysqldump into a private partial file, then atomically promote to *output_path*."""
    service = _require_mysql_service(service)
    if output_path.exists():
        die(f"Refusing to overwrite existing backup vibeops/{rel(output_path)}")
    mkdir(output_path.parent, 0o700)

    token = secrets.token_hex(8)
    partial = output_path.parent / f"{output_path.name}.partial-{token}"
    quoted = " ".join(shlex.quote(a) for a in mysqldump_args)
    cmd = compose_command(
        "exec",
        "-T",
        service,
        "sh",
        "-lc",
        f"mysqldump --defaults-extra-file=/run/secrets/vibeops-root.cnf "
        f"--single-transaction --routines --triggers --events "
        f"--default-character-set=utf8mb4 {quoted}",
    )

    promoted = False
    try:
        with _open_private_partial(partial) as fh:
            cp = run_stdout_to_file(cmd, stdout_file=fh, check=False)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass

        if cp.returncode != 0:
            err = (cp.stderr or b"").decode("utf-8", errors="replace").strip()
            die(
                f"mysqldump on {service} failed (exit {cp.returncode})"
                + (f": {err}" if err else "")
            )

        if not partial.exists() or partial.stat().st_size == 0:
            die(f"mysqldump on {service} produced empty output for vibeops/{rel(output_path)}")

        if output_path.exists():
            die(f"Refusing to overwrite existing backup vibeops/{rel(output_path)}")

        os.replace(str(partial), str(output_path))
        promoted = True
        _fsync_dir(output_path.parent)
    finally:
        if not promoted and partial.exists():
            partial.unlink(missing_ok=True)


def mysql_root_stream_sql_file(path: Path, *, service: str) -> None:
    """Stream a SQL dump file into mysql without loading it into Python memory."""
    service = _require_mysql_service(service)
    if path.is_symlink() or not path.is_file():
        die(f"Backup path is not a regular file: {path}")
    size = path.stat().st_size
    if size == 0:
        die(f"Backup file is empty: vibeops/{rel(path)}")

    cmd = compose_command(
        "exec",
        "-T",
        service,
        "sh",
        "-lc",
        "mysql --defaults-extra-file=/run/secrets/vibeops-root.cnf --batch --raw",
    )
    with path.open("rb") as fh:
        cp = run_stdin_stream(cmd, stdin_file=fh, check=False, capture_stdout=True)
    if cp.returncode != 0:
        err = (cp.stderr or cp.stdout or b"").decode("utf-8", errors="replace").strip()
        # Avoid echoing secrets; mysql may warn about CLI password usage inside the container.
        die(f"mysql on {service} failed (exit {cp.returncode})" + (f": {err}" if err else ""))


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
            compose_command(
                "exec",
                "-e",
                f"MYSQL_USER={username}",
                "-e",
                f"MYSQL_PWD={password}",
                service,
                "sh",
                "-lc",
                'mysql -u"$MYSQL_USER" -p"$MYSQL_PWD"',
            ),
            cwd=str(ROOT),
            check=False,
        )
        raise SystemExit(cp.returncode)
    cp = subprocess.run(
        compose_command(
            "exec",
            service,
            "sh",
            "-lc",
            "mysql --defaults-extra-file=/run/secrets/vibeops-root.cnf",
        ),
        cwd=str(ROOT),
        check=False,
    )
    raise SystemExit(cp.returncode)


def _validate_keep(keep: int | None) -> int | None:
    """``--keep`` must be a positive integer; zero is rejected as too destructive by default."""
    if keep is None:
        return None
    if keep < 1:
        die("--keep must be a positive integer (>= 1); omit --keep to retain all backups")
    return keep


def cmd_db_backup(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    backup_dir = mysql_backup_dir(service)
    mkdir(backup_dir, 0o700)
    stamp = _stamp()
    keep = _validate_keep(args.keep)
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
    try:
        for db_name in targets:
            out = _reserve_backup_path(backup_dir, stamp, db_name)
            mysql_root_dump(["--databases", db_name], service=service, output_path=out)
            written.append(out)
            info(f"Wrote vibeops/{rel(out)}")
    except StackError:
        if written:
            names = ", ".join(f"vibeops/{rel(p)}" for p in written)
            warn(
                f"Backup batch stopped after failure; "
                f"{len(written)} dump(s) safely written (no retention applied): {names}"
            )
        raise

    if keep is not None:
        _apply_retention(backup_dir, keep=keep)

    if not written:
        die("No backups written")


def _is_final_sql_backup(path: Path) -> bool:
    """True for regular finalized ``*.sql`` files (not partials, not symlinks)."""
    if path.suffix != ".sql":
        return False
    if path.is_symlink():
        return False
    try:
        return path.is_file()
    except OSError:
        return False


def _list_final_backups(backup_dir: Path) -> list[Path]:
    if not backup_dir.is_dir():
        return []
    files = [p for p in backup_dir.glob("*.sql") if _is_final_sql_backup(p)]
    return sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)


def _apply_retention(backup_dir: Path, *, keep: int) -> None:
    files = _list_final_backups(backup_dir)
    for path in files[keep:]:
        path.unlink(missing_ok=True)
        info(f"Removed old backup vibeops/{rel(path)}")


def cmd_db_list_backups(args: argparse.Namespace) -> None:
    service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    backup_dir = mysql_backup_dir(service)
    files = _list_final_backups(backup_dir)
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
    if path.is_file() and not path.is_symlink():
        return path.resolve()
    candidate = mysql_backup_dir(service) / raw
    if candidate.is_file() and not candidate.is_symlink():
        return candidate.resolve()
    # Also allow relative path without vibeops/ prefix
    alt = ROOT / raw
    if alt.is_file() and not alt.is_symlink():
        return alt.resolve()
    die(f"Backup file not found: {raw}")


def cmd_db_restore(args: argparse.Namespace) -> None:
    service = _require_mysql_service(args.mysql_service)
    path = _resolve_backup_path(args.backup_file, service)
    if not args.yes:
        if sys.stdin.isatty():
            answer = input(
                f"Restore {rel(path)} into {service}? This may overwrite objects. Type 'yes' to continue: "
            ).strip().lower()
            if answer != "yes":
                die("Restore aborted")
        else:
            die("Restore requires --yes when stdin is not a TTY")

    if path.stat().st_size == 0:
        die(f"Backup file is empty: vibeops/{rel(path)}")
    warn(
        f"Restoring vibeops/{rel(path)} into {service} "
        f"(streaming input; objects in the dump may be overwritten — not atomic at the MySQL object level)"
    )
    mysql_root_stream_sql_file(path, service=service)
    info(f"Restored vibeops/{rel(path)} into {service}")
