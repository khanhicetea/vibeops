"""MySQL option files, SQL helpers, and database provisioning primitives."""

from __future__ import annotations

from bento.services.compose import compose_prefix

import re
import secrets
import subprocess
from pathlib import Path
from typing import Any

from bento.utils.env import default_mysql_service, mysql_root_password, parse_env_file, stack_env
from bento.utils.errors import die, info
from bento.os.fsutil import mkdir, write_text_atomic
from bento.utils.paths import HOME_DIR, MYSQL_SECRETS_DIR, MYSQL_TEMPLATE_DIR, ROOT, RUNTIME_DIR, RenderContext, rel
from bento.os.process import run, service_running
from bento.services.rendering import template_text, write_template
from bento.utils.validation import APP_NAME_RE, DB_NAME_RE, MYSQL_SERVICE_RE, validate

def mysql_root_option_file(service: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.mysql_root_option_file(service)
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    return MYSQL_SECRETS_DIR / f"{service}-root.cnf"


def escape_mysql_option_value(value: str) -> str:
    """Escape a value for a double-quoted MySQL option-file assignment.

    MySQL option files treat ``\\`` and ``"`` specially inside double quotes.
    Do not log or print the result when it embeds a secret.
    """
    return value.replace("\\", "\\\\").replace('"', '\\"')


def mysql_client_option_file_content(
    *,
    user: str,
    password: str,
    protocol: str | None = None,
) -> str:
    """Build a ``[client]`` MySQL option-file body for the given credentials.

    User and password are always double-quoted with MySQL option escaping so
    backslashes/quotes cannot inject extra option lines. Do not log the return value.
    """
    # Reject control characters that would break option-file line structure even
    # inside quotes (MySQL has no portable escape for raw newlines in values).
    for label, value in (("user", user), ("password", password)):
        if any(ch in value for ch in ("\n", "\r", "\0")):
            die(f"MySQL option-file {label} must not contain control characters")
    lines = [
        "[client]",
        f'user="{escape_mysql_option_value(user)}"',
        f'password="{escape_mysql_option_value(password)}"',
    ]
    if protocol:
        # protocol is a fixed keyword (e.g. socket/tcp), never a secret.
        if not re.fullmatch(r"[A-Za-z0-9_]+", protocol):
            die(f"Invalid MySQL option-file protocol: {protocol}")
        lines.append(f"protocol={protocol}")
    return "\n".join(lines) + "\n"


def render_mysql_root_option_files(ctx: RenderContext | None = None, db: dict[str, Any] | None = None) -> list[Path]:
    """Write root client option files for managed MySQL services."""
    from bento.services.mysql_versions import managed_mysql_versions, mysql_service_for
    from bento.services.state import load_db

    env = stack_env()
    rendered: list[Path] = []
    for service in (mysql_service_for(version) for version in managed_mysql_versions(db or load_db())):
        password = mysql_root_password(env, service)
        if not password:
            continue
        path = mysql_root_option_file(service, ctx)
        content = mysql_client_option_file_content(user="root", password=password, protocol="socket")
        write_text_atomic(path, content, 0o600)
        rendered.append(path)
    return rendered


def mysql_string_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "''")


def mysql_grant_pattern(value: str) -> str:
    """Escape MySQL GRANT database-pattern wildcards for a literal identifier fragment."""
    return value.replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%")


def mysql_user_database_grant_pattern(username: str) -> str:
    """Return the database pattern for all databases owned by username: <username>_*.

    In MySQL GRANT database patterns, ``_`` and ``%`` are wildcards even inside the
    database pattern. Escape username wildcards and append an escaped separator
    underscore so ``foo_bar`` grants ``foo_bar_*``, not ``fooXbar_*``.
    """
    return mysql_grant_pattern(username) + r"\_%"


def mysql_backup_dir(service: str) -> Path:
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    return RUNTIME_DIR / "backups" / service


def mysql_log_dir(service: str) -> Path:
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    return RUNTIME_DIR / "logs" / service

SYSTEM_MYSQL_DATABASES = frozenset({"mysql", "sys", "performance_schema", "information_schema"})


def mysql_root_exec_sql(sql: str, *, service: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run SQL as MySQL root using the protected client option file."""
    service = validate(service or default_mysql_service(), MYSQL_SERVICE_RE, "MySQL service")
    if not service_running(service):
        die(f"{service} service is not running")
    cp = run(
        [*compose_prefix(),
             "exec", "-T", service,
            "sh", "-lc",
            'mysql --defaults-extra-file=/run/secrets/bento-root.cnf --batch --raw',
        ],
        input_text=sql,
        check=False,
        capture=True,
    )
    if check and cp.returncode != 0:
        err = (cp.stderr or cp.stdout or "").strip()
        # Avoid echoing secrets; mysql may warn about CLI password usage inside the container.
        die(f"mysql on {service} failed (exit {cp.returncode})" + (f": {err}" if err else ""))
    return cp


def mysql_admin_ping(service: str | None = None) -> bool:
    service = validate(service or default_mysql_service(), MYSQL_SERVICE_RE, "MySQL service")
    if not service_running(service):
        return False
    cp = run(
        [*compose_prefix(),
             "exec", "-T", service,
            "sh", "-lc",
            'mysqladmin --defaults-extra-file=/run/secrets/bento-root.cnf ping --silent',
        ],
        check=False,
        capture=True,
    )
    return cp.returncode == 0


def generate_password(length: int = 20) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def create_mysql_user(username: str, password: str | None, mysql_service: str) -> tuple[bool, str | None]:
    env = stack_env()
    mysql_service = validate(mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    if not (ROOT / ".env").exists() or not service_running(mysql_service):
        info(f"Skipped MySQL user creation; start {mysql_service} and rerun, or pass --no-mysql.")
        return False, None
    if not mysql_root_password(env, mysql_service):
        info(f"Skipped MySQL user creation; {mysql_service.upper()}_ROOT_PASSWORD or MYSQL_ROOT_PASSWORD is missing.")
        return False, None

    cred_dir = HOME_DIR / username / ".credentials"
    cred_path = cred_dir / f"{mysql_service}.env"
    existing_password = parse_env_file(cred_path).get("MYSQL_PASSWORD") if cred_path.exists() else None
    password = password or env.get(f"{mysql_service.upper()}_USER_PASSWORD") or env.get("MYSQL_USER_PASSWORD") or existing_password or generate_password()
    mkdir(cred_dir, 0o700)
    write_template(cred_path, MYSQL_TEMPLATE_DIR / "user-credentials.env.template", {
        "USERNAME": username,
        "MYSQL_SERVICE": mysql_service,
        "MYSQL_PASSWORD": password,
    }, 0o600)

    sql = template_text(MYSQL_TEMPLATE_DIR / "create-user.sql.template", {
        "USERNAME": username,
        "MYSQL_PASSWORD_SQL": mysql_string_literal(password),
        "DB_GRANT_PATTERN": mysql_user_database_grant_pattern(username),
    })
    mysql_root_exec_sql(sql, service=mysql_service)
    info(f"MySQL account ready on {mysql_service}: user={username}")
    info(f"Credentials saved (mode 600): {rel(cred_path)}")
    info("Password is only in that file; not printed here.")
    return True, rel(cred_path)


def apply_app_mysql_metadata(app: dict[str, Any], app_name: str, mysql_service: str, credential_path: str | None = None) -> None:
    app["mysql_service"] = mysql_service
    app["mysql_host"] = mysql_service
    app["mysql_port"] = 3306
    app["mysql_user_name"] = app_name
    if credential_path:
        app["mysql_credentials"] = credential_path


def resolve_app_mysql_service(
    db: dict[str, Any],
    app_name: str,
    requested: str | None = None,
    *,
    allow_new: bool = False,
) -> str:
    """Resolve an app's single MySQL service without mutating state.

    Existing apps may not create users or databases on another MySQL instance;
    changing instances requires an explicit migration workflow.
    """
    apps = db.get("apps") if isinstance(db, dict) else None
    app = apps.get(app_name) if isinstance(apps, dict) else None
    if isinstance(app, dict):
        recorded_raw = app.get("mysql_service")
        if recorded_raw is None or str(recorded_raw).strip() == "":
            defaults = db.get("defaults") if isinstance(db.get("defaults"), dict) else {}
            recorded_raw = defaults.get("mysql_service") or default_mysql_service()
        recorded = validate(str(recorded_raw), MYSQL_SERVICE_RE, "MySQL service")
        if requested is None:
            return recorded
        selected = validate(str(requested), MYSQL_SERVICE_RE, "MySQL service")
        if selected != recorded:
            die(
                f"App {app_name} uses {recorded}, not {selected}. "
                "Creating app users or databases across multiple MySQL services is not supported; "
                "migrate the app explicitly before changing MySQL service."
            )
        return recorded

    if not allow_new:
        die(f"Unknown app: {app_name}")
    return validate(requested or default_mysql_service(), MYSQL_SERVICE_RE, "MySQL service")


def require_mysql_ready_for_sql(service: str) -> str:
    """Fail unless the MySQL service can accept root SQL administration.

    Checks running state, root password configuration, and the protected client
    option file. Does not start services or mutate Docker state.
    """
    service = validate(service, MYSQL_SERVICE_RE, "MySQL service")
    env = stack_env()
    if not (ROOT / ".env").exists() or not service_running(service) or not mysql_root_password(env, service):
        die(f"Cannot create database; {service} is not running, .env is missing, or root password is unset.")
    option_file = mysql_root_option_file(service)
    if not option_file.is_file():
        die(f"Missing protected MySQL option file {rel(option_file)}; run ./manage.py render")
    return service


def record_restored_database(old_database: str, target_database: str, service: str) -> None:
    """Record a newly restored database when its source belongs to a managed app."""
    if target_database == old_database:
        return
    from bento.services.state import load_db, save_db, upsert_timestamp

    db = load_db()
    for app in db.get("apps", {}).values():
        databases = app.get("databases", [])
        services = app.get("database_services", {})
        source_service = services.get(old_database) or app.get("mysql_service")
        if old_database not in databases or source_service != service:
            continue
        if target_database not in databases:
            databases.append(target_database)
        app.setdefault("database_services", {})[target_database] = service
        upsert_timestamp(app)
        save_db(db)
        return


def ensure_mysql_database(app_name: str, suffix: str, mysql_service: str) -> str:
    """Create DB app_name_suffix and grant <app_name>_* privileges. Returns full name only after SQL succeeds."""
    mysql_service = require_mysql_ready_for_sql(mysql_service)
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    validate(suffix, DB_NAME_RE, "database suffix")
    db_full_name = f"{app_name}_{suffix}"
    sql = template_text(MYSQL_TEMPLATE_DIR / "create-database.sql.template", {
        "DB_FULL_NAME": db_full_name,
        "USERNAME": app_name,
        "DB_GRANT_PATTERN": mysql_user_database_grant_pattern(app_name),
    })
    mysql_root_exec_sql(sql, service=mysql_service)
    info(f"MySQL database on {mysql_service}: {db_full_name}")
    return db_full_name
