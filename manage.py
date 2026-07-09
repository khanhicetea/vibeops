#!/usr/bin/env python3
"""Pure-Python management CLI for VibeOps.

VibeOps is a vibe-coding ops stack. No third-party dependencies are required.
The CLI keeps lightweight metadata in ./stack.json while still generating the
same filesystem artifacts consumed by Docker, PHP-FPM, supercronic, and nginx.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "stack.json"
CONFIG_DIR = ROOT / "config"
RUNTIME_DIR = ROOT / "runtime"
HOME_DIR = RUNTIME_DIR / "home"
PHP_CONFIG_DIR = CONFIG_DIR / "php"
PHP_VERSIONS_DIR = PHP_CONFIG_DIR / "versions"
PHP_TEMPLATE_DIR = PHP_CONFIG_DIR / "templates"
MYSQL_TEMPLATE_DIR = CONFIG_DIR / "mysql" / "templates"
NGINX_TEMPLATE_DIR = CONFIG_DIR / "nginx" / "templates"
NGINX_VHOST_DIR = RUNTIME_DIR / "nginx" / "vhosts"
CERTS_DIR = RUNTIME_DIR / "certs"
PHP_SOCKET_DIR = RUNTIME_DIR / "run" / "php-fpm"
PHP_LOG_DIR = RUNTIME_DIR / "logs" / "php"
CRON_RUNTIME_DIR = RUNTIME_DIR / "cron"
SCHEMA_VERSION = 1

USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
DOMAIN_RE = re.compile(r"^[A-Za-z0-9.-]+$")
DOMAIN_PATH_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PHP_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+$")
DB_NAME_RE = re.compile(r"^[A-Za-z0-9_]+$")
MYSQL_SERVICE_RE = re.compile(r"^mysql[0-9]+$")
JOB_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class StackError(RuntimeError):
    pass


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def rel(path: Path | str) -> str:
    p = Path(path)
    try:
        return str(p.resolve().relative_to(ROOT))
    except Exception:
        return str(p)


def info(message: str) -> None:
    print(message)


def warn(message: str) -> None:
    print(f"Warning: {message}", file=sys.stderr)


def die(message: str) -> None:
    raise StackError(message)


def validate(value: str, pattern: re.Pattern[str], label: str) -> str:
    if not value or not pattern.match(value):
        die(f"Invalid {label}: {value}")
    return value


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            env[key] = value
    return env


def stack_env() -> dict[str, str]:
    env = parse_env_file(ROOT / ".env")
    merged = dict(env)
    merged.update(os.environ)
    return merged


def default_php_version() -> str:
    return stack_env().get("DEFAULT_PHP_VERSION", "8.4")


def default_mysql_service() -> str:
    return stack_env().get("DEFAULT_MYSQL_SERVICE", "mysql84")


def mysql_root_password(env: dict[str, str], service: str) -> str | None:
    return env.get(f"{service.upper()}_ROOT_PASSWORD") or env.get("MYSQL_ROOT_PASSWORD")


def php_service_for(version: str) -> str:
    return "php" + version.replace(".", "")


def php_cron_service_for(version: str) -> str:
    return php_service_for(version) + "-cron"


def php_cli_service_for(version: str) -> str:
    return php_service_for(version) + "-cli"


def php_version_config_dir(version: str) -> Path:
    return PHP_VERSIONS_DIR / version


def cron_dir_for(version: str) -> Path:
    return CRON_RUNTIME_DIR / php_service_for(version)


def cron_jobs_dir_for(version: str) -> Path:
    return cron_dir_for(version) / "jobs"


def load_db() -> dict[str, Any]:
    if not DB_PATH.exists():
        return {
            "schema": SCHEMA_VERSION,
            "users": {},
            "sites": {},
            "crons": {},
            "updated_at": now(),
        }
    try:
        data = json.loads(DB_PATH.read_text())
    except json.JSONDecodeError as exc:
        die(f"Cannot parse {rel(DB_PATH)}: {exc}")
    if not isinstance(data, dict):
        die(f"{rel(DB_PATH)} must contain a JSON object")
    data.setdefault("schema", SCHEMA_VERSION)
    data.setdefault("users", {})
    data.setdefault("sites", {})
    data.setdefault("crons", {})
    return data


def save_db(data: dict[str, Any]) -> None:
    data["schema"] = SCHEMA_VERSION
    data["updated_at"] = now()
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    fd, tmp_name = tempfile.mkstemp(prefix=".stack.", suffix=".json", dir=str(ROOT))
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp_name, DB_PATH)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def upsert_timestamp(item: dict[str, Any]) -> None:
    item.setdefault("created_at", now())
    item["updated_at"] = now()


def mkdir(path: Path, mode: int | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if mode is not None:
        try:
            path.chmod(mode)
        except PermissionError:
            warn(f"could not chmod {rel(path)}")


def write_text(path: Path, content: str, mode: int | None = None) -> None:
    mkdir(path.parent)
    path.write_text(content)
    if mode is not None:
        try:
            path.chmod(mode)
        except PermissionError:
            warn(f"could not chmod {rel(path)}")


def render_template_text(text: str, values: dict[str, Any]) -> str:
    for key, value in values.items():
        text = text.replace(f"__{key}__", str(value))
    return text


def template_text(path: Path, values: dict[str, Any]) -> str:
    if not path.exists():
        die(f"Missing template: vibeops/{rel(path)}")
    return render_template_text(path.read_text(), values)


def write_template(path: Path, template: Path, values: dict[str, Any], mode: int | None = None) -> None:
    write_text(path, template_text(template, values), mode)


def mysql_string_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "''")


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def run(cmd: list[str], *, input_text: str | None = None, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(ROOT),
        input=input_text,
        text=True,
        check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def docker_available() -> bool:
    return command_exists("docker")


def running_services() -> set[str]:
    if not docker_available():
        return set()
    cp = run(
        ["docker", "compose", "ps", "--services", "--filter", "status=running"],
        check=False,
        capture=True,
    )
    if cp.returncode != 0:
        return set()
    return {line.strip() for line in cp.stdout.splitlines() if line.strip()}


def service_running(service: str) -> bool:
    return service in running_services()


def nginx_reload(no_reload: bool = False) -> None:
    if no_reload:
        return
    if service_running("nginx"):
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-s", "reload"])
        info("Reloaded nginx")
    else:
        info("nginx container is not running; start it then run: docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload")


def php_disable_default_pool(service: str) -> None:
    # Official PHP images ship [www] fragments in more than one file (for
    # example www.conf and sometimes docker.conf). VibeOps uses only generated
    # per-user pools, so disable any default [www] fragments at runtime too.
    run([
        "docker", "compose", "exec", "-T", service, "sh", "-lc",
        "for f in /usr/local/etc/php-fpm.d/*.conf; do "
        "[ -e \"$f\" ] || continue; "
        "if grep -q '^\\[www\\]' \"$f\"; then mv \"$f\" \"$f.disabled\"; fi; "
        "done; "
        "rm -f /usr/local/etc/php-fpm.d/zz-pools.conf; "
        "printf '[global]\\nerror_log = /proc/self/fd/2\\nprocess.max = 32\\ninclude=/usr/local/etc/php-fpm.d/pools/*.conf\\n' > /usr/local/etc/php-fpm.d/zz-vibeops.conf; ",
    ], check=False)


def php_reload(service: str, username: str, no_reload: bool = False) -> None:
    if service_running(service):
        php_disable_default_pool(service)
        run(["docker", "compose", "exec", "-T", service, "php-user-sync", username])
        if not no_reload:
            run(["docker", "compose", "exec", "-T", service, "php-fpm", "-tt"])
            run([
                "docker", "compose", "exec", "-T", service, "sh", "-lc",
                "kill -USR2 1",
            ])
            info(f"Reloaded {service}")
    else:
        info(f"{service} is not running; run/restart it to create the Linux user inside that PHP container.")


def rebuild_supercronic_crontab(php_version: str) -> Path:
    cron_dir = cron_dir_for(php_version)
    mkdir(cron_dir)
    combined = cron_dir / ".supercronic.cron"
    lines = [
        "SHELL=/bin/sh",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "",
    ]
    for cron_file in sorted(cron_jobs_dir_for(php_version).glob("*.cron")):
        lines.append(f"# /usr/local/etc/php/cron.d/{cron_file.name}")
        lines.append(cron_file.read_text().rstrip("\n"))
        lines.append("")
    write_text(combined, "\n".join(lines) + "\n", 0o644)
    return combined


def cron_reload(service: str, usernames: Iterable[str] = ()) -> None:
    if service_running(service):
        script = r'''
set -eu
php-user-sync "$@"
cmdline="$(tr '\000' ' ' < /proc/1/cmdline || true)"
case "$cmdline" in
  *supercronic*) kill -USR2 1 ;;
  *) echo "Supercronic is not running as PID 1 ($cmdline)" >&2; exit 42 ;;
esac
'''
        cp = run(["docker", "compose", "exec", "-T", service, "sh", "-lc", script, "--", *usernames], check=False)
        if cp.returncode == 0:
            info(f"Reloaded {service} cron with SIGUSR2")
        elif cp.returncode == 42:
            run(["docker", "compose", "restart", service])
            info(f"Restarted idle {service} to start Supercronic")
        else:
            die(f"Failed to reload {service} cron (exit {cp.returncode})")
    else:
        info(f"{service} is not running; start it to load this cron job.")


def read_uid_from_env(path: Path) -> int | None:
    try:
        for line in path.read_text().splitlines():
            if line.startswith("UID="):
                return int(line.split("=", 1)[1])
    except Exception:
        return None
    return None


def allocate_uid(username: str, explicit_uid: int | None, db: dict[str, Any]) -> int:
    if explicit_uid is not None:
        return explicit_uid

    existing = db.get("users", {}).get(username, {}).get("uid")
    if isinstance(existing, int):
        return existing

    for path in sorted(PHP_VERSIONS_DIR.glob(f"*/users.d/{username}.env")):
        uid = read_uid_from_env(path)
        if uid is not None:
            return uid

    max_uid = 0
    for user in db.get("users", {}).values():
        uid = user.get("uid") if isinstance(user, dict) else None
        if isinstance(uid, int):
            max_uid = max(max_uid, uid)
    for path in PHP_VERSIONS_DIR.glob("*/users.d/*.env"):
        uid = read_uid_from_env(path)
        if uid is not None:
            max_uid = max(max_uid, uid)
    return 10000 if max_uid < 10000 else max_uid + 1


def generate_password(length: int = 20) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def create_mysql_user(username: str, password: str | None, mysql_service: str) -> tuple[bool, str | None]:
    env = stack_env()
    mysql_service = validate(mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    if not (ROOT / ".env").exists() or not service_running(mysql_service):
        info(f"Skipped MySQL user creation; start {mysql_service} and rerun, or pass --no-mysql.")
        return False, None
    root_password = mysql_root_password(env, mysql_service)
    if not root_password:
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
    })
    run(["docker", "compose", "exec", "-T", mysql_service, "mysql", "-uroot", f"-p{root_password}"], input_text=sql)
    info(f"MySQL account on {mysql_service}: {username} / {password}")
    info(f"Saved: vibeops/{rel(cred_path)}")
    return True, rel(cred_path)


def cmd_user_create(args: argparse.Namespace, *, db: dict[str, Any] | None = None, save: bool = True) -> None:
    db = db if db is not None else load_db()
    username = validate(args.username, USERNAME_RE, "username")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    user_uid = allocate_uid(username, args.uid, db)
    php_service = php_service_for(php_version)
    socket_group_name = stack_env().get("SOCKET_GROUP_NAME", "nginxsock")

    mkdir(HOME_DIR / username / "logs", 0o770)
    mkdir(php_version_config_dir(php_version) / "users.d")
    mkdir(php_version_config_dir(php_version) / "pool.d")
    mkdir(cron_dir_for(php_version))
    mkdir(PHP_SOCKET_DIR / php_service)
    mkdir(PHP_LOG_DIR / php_service)

    fallback_path = php_version_config_dir(php_version) / "pool.d" / "zz-fallback.conf"
    if not fallback_path.exists():
        write_template(fallback_path, PHP_TEMPLATE_DIR / "fallback.conf.template", {
            "SOCKET_GROUP_NAME": socket_group_name,
        })

    write_template(php_version_config_dir(php_version) / "users.d" / f"{username}.env", PHP_TEMPLATE_DIR / "user.env.template", {
        "USERNAME": username,
        "UID": user_uid,
    })
    write_template(php_version_config_dir(php_version) / "pool.d" / f"{username}.conf", PHP_TEMPLATE_DIR / "pool.conf.template", {
        "USERNAME": username,
        "SOCKET_GROUP_NAME": socket_group_name,
        "PHP_VERSION": php_version,
    })
    try:
        (HOME_DIR / username).chmod(0o750)
    except PermissionError:
        warn(f"could not chmod home/{username}")

    info(f"Created PHP {php_version} user config: {username} uid={user_uid}")
    info(f"Home: vibeops/{rel(HOME_DIR / username)}")
    info(f"Pool: vibeops/{rel(php_version_config_dir(php_version) / 'pool.d' / f'{username}.conf')}")
    info(f"Socket: vibeops/{rel(PHP_SOCKET_DIR / php_service / f'{username}.sock')}")

    php_reload(php_service, username, no_reload=args.no_reload)

    mysql_created = False
    credential_path = None
    if not args.no_mysql:
        mysql_created, credential_path = create_mysql_user(username, args.mysql_password, args.mysql_service)

    user = db["users"].setdefault(username, {})
    user["uid"] = user_uid
    user.setdefault("home", rel(HOME_DIR / username))
    versions = set(user.get("php_versions", []))
    versions.add(php_version)
    user["php_versions"] = sorted(versions)
    if mysql_created:
        user["mysql_user"] = True
        user["mysql_service"] = args.mysql_service
    if credential_path:
        user["mysql_credentials"] = credential_path
    upsert_timestamp(user)
    if save:
        save_db(db)


def ensure_user(username: str, php_version: str, db: dict[str, Any], no_reload: bool = False, mysql_service: str | None = None) -> None:
    if (php_version_config_dir(php_version) / "users.d" / f"{username}.env").exists():
        return
    info(f"PHP {php_version} user {username} does not exist; creating it first.")
    ns = argparse.Namespace(username=username, uid=None, php=php_version, no_mysql=False, mysql_password=None, mysql_service=mysql_service or default_mysql_service(), no_reload=no_reload)
    cmd_user_create(ns, db=db, save=False)


def render_template(template: Path, destination: Path, values: dict[str, Any]) -> None:
    write_template(destination, template, values)


def normalize_aliases(alias: Iterable[str] | None, aliases: str | None) -> list[str]:
    out: list[str] = []
    for value in alias or []:
        for item in value.split(","):
            item = item.strip()
            if item:
                out.append(validate(item, DOMAIN_RE, "alias domain"))
    if aliases:
        for item in aliases.split(","):
            item = item.strip()
            if item:
                out.append(validate(item, DOMAIN_RE, "alias domain"))
    return sorted(dict.fromkeys(out))


def cmd_site_create(args: argparse.Namespace) -> None:
    db = load_db()
    username = validate(args.username, USERNAME_RE, "username")
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    mysql_service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    db_name = args.db_name
    if db_name:
        validate(db_name, DB_NAME_RE, "db_name")
    aliases = normalize_aliases(args.alias, args.aliases)
    php_service = php_service_for(php_version)

    ensure_user(username, php_version, db, no_reload=args.no_reload, mysql_service=mysql_service)

    site_root = HOME_DIR / username / main_domain
    mkdir(site_root)
    mkdir(HOME_DIR / username / "logs")

    index_path = site_root / "index.php"
    if not args.no_index and not index_path.exists():
        write_template(index_path, PHP_TEMPLATE_DIR / "index.php.template", {
            "MAIN_DOMAIN": main_domain,
            "PHP_VERSION": php_version,
        })

    server_names = " ".join([main_domain] + aliases)
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    render_template(NGINX_TEMPLATE_DIR / "site.conf.template", conf_path, {
        "USERNAME": username,
        "MAIN_DOMAIN": main_domain,
        "SERVER_NAMES": server_names,
        "PHP_SERVICE": php_service,
    })

    info(f"Created HTTP+HTTPS PHP vhost with default self-signed cert: vibeops/{rel(conf_path)}")
    info(f"Document root: vibeops/{rel(site_root)}")
    info(f"PHP-FPM: {php_version} via /run/php-fpm/{php_service}/{username}.sock")

    if service_running(php_service):
        php_disable_default_pool(php_service)
        run(["docker", "compose", "exec", "-T", php_service, "php-user-sync", username])

    db_full_name = None
    if db_name:
        db_full_name = f"{username}_{db_name}"
        env = stack_env()
        root_password = mysql_root_password(env, mysql_service)
        if (ROOT / ".env").exists() and service_running(mysql_service) and root_password:
            create_mysql_user(username, None, mysql_service)
            sql = template_text(MYSQL_TEMPLATE_DIR / "create-database.sql.template", {
                "DB_FULL_NAME": db_full_name,
                "USERNAME": username,
            })
            run(["docker", "compose", "exec", "-T", mysql_service, "mysql", "-uroot", f"-p{root_password}"], input_text=sql)
            info(f"MySQL database on {mysql_service}: {db_full_name}")
        else:
            info(f"Skipped database creation; {mysql_service} is not running, .env is missing, or root password is unset.")

    site = db["sites"].setdefault(main_domain, {})
    site.update({
        "type": "php",
        "domain": main_domain,
        "aliases": aliases,
        "user": username,
        "php_version": php_version,
        "php_service": php_service,
        "mysql_service": mysql_service,
        "root": rel(site_root),
        "vhost": rel(conf_path),
        "tls": site.get("tls", {"mode": "self-signed"}),
    })
    if db_name:
        site["db_name"] = db_name
        site["db_full_name"] = db_full_name
    upsert_timestamp(site)
    save_db(db)
    nginx_reload(args.no_reload)


def cmd_proxy_create(args: argparse.Namespace) -> None:
    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    upstream = args.upstream
    if not upstream:
        die("upstream is required")
    aliases = normalize_aliases(args.alias, args.aliases)
    server_names = " ".join([main_domain] + aliases)
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    render_template(NGINX_TEMPLATE_DIR / "proxy.conf.template", conf_path, {
        "MAIN_DOMAIN": main_domain,
        "SERVER_NAMES": server_names,
        "UPSTREAM": upstream,
    })
    info(f"Created HTTP+HTTPS proxy vhost with default self-signed cert: vibeops/{rel(conf_path)}")

    site = db["sites"].setdefault(main_domain, {})
    site.update({
        "type": "proxy",
        "domain": main_domain,
        "aliases": aliases,
        "upstream": upstream,
        "vhost": rel(conf_path),
        "tls": site.get("tls", {"mode": "self-signed"}),
    })
    upsert_timestamp(site)
    save_db(db)
    nginx_reload(args.no_reload)


def safe_domain_part(domain: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", domain)


def cmd_cron_create(args: argparse.Namespace) -> None:
    db = load_db()
    username = validate(args.username, USERNAME_RE, "username")
    domain = validate(args.domain, DOMAIN_PATH_RE, "domain/path name")
    job_name = validate(args.job_name, JOB_RE, "job-name")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    schedule = args.schedule
    command = args.command
    if not schedule or not command:
        die("schedule and command are required")
    php_service = php_cron_service_for(php_version)
    app_home = f"/home/{username}"
    workdir = args.workdir or f"{app_home}/{domain}"

    ensure_user(username, php_version, db)
    mkdir(cron_jobs_dir_for(php_version))
    mkdir(HOME_DIR / username / domain)

    cron_path = cron_jobs_dir_for(php_version) / f"{username}-{safe_domain_part(domain)}-{job_name}.cron"
    write_template(cron_path, PHP_TEMPLATE_DIR / "cron.cron.template", {
        "USERNAME": username,
        "DOMAIN": domain,
        "PHP_VERSION": php_version,
        "PHP_SERVICE": php_service,
        "SCHEDULE": schedule,
        "QUOTED_USERNAME": shlex.quote(username),
        "QUOTED_WORKDIR": shlex.quote(workdir),
        "QUOTED_COMMAND": shlex.quote(command),
    }, 0o644)

    info(f"Created cron job: vibeops/{rel(cron_path)}")
    info(f"Runs as: {username}")
    info(f"Workdir: {workdir}")
    combined_crontab = rebuild_supercronic_crontab(php_version)
    info(f"Updated Supercronic crontab: vibeops/{rel(combined_crontab)}")
    info(f"Command: {command}")

    cron_key = f"{username}/{domain}/{job_name}"
    cron = db["crons"].setdefault(cron_key, {})
    cron.update({
        "user": username,
        "domain": domain,
        "job_name": job_name,
        "php_version": php_version,
        "php_service": php_service,
        "schedule": schedule,
        "command": command,
        "workdir": workdir,
        "path": rel(cron_path),
    })
    upsert_timestamp(cron)
    save_db(db)
    cron_reload(php_service, [username])


def cmd_cron_reload(args: argparse.Namespace) -> None:
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    combined_crontab = rebuild_supercronic_crontab(php_version)
    info(f"Updated Supercronic crontab: vibeops/{rel(combined_crontab)}")
    cron_reload(php_cron_service_for(php_version))


def replace_tls_block(conf_path: Path, replacement: str) -> None:
    text = conf_path.read_text()
    text2, count = re.subn(r"# BEGIN TLS_CERTIFICATE\n.*?\n\s*# END TLS_CERTIFICATE", lambda _: replacement, text, count=1, flags=re.S)
    if count != 1:
        die(f"Could not find marked TLS certificate block in {rel(conf_path)}")
    write_text(conf_path, text2)


def set_https_redirect(conf_path: Path, enabled: bool) -> None:
    """Toggle the generated HTTP vhost redirect flag."""
    text = conf_path.read_text()
    value = "1" if enabled else "0"

    if "set $enable_https_redirect" in text:
        text2, count = re.subn(r"set \$enable_https_redirect [01];", f"set $enable_https_redirect {value};", text, count=1)
    else:
        listen_pos = text.find("listen 80;")
        server_name_pos = text.find("server_name ", listen_pos)
        insert_pos = text.find(";", server_name_pos) + 1 if server_name_pos >= 0 else 0
        if listen_pos < 0 or server_name_pos < 0 or insert_pos <= 0:
            warn(f"Could not find generated HTTP server in {rel(conf_path)}; skipped HTTPS redirect toggle")
            return
        text2 = text[:insert_pos] + f"\n\n    set $enable_https_redirect {value};" + text[insert_pos:]
        count = 1

    if count:
        write_text(conf_path, text2)
        info(("Enabled" if enabled else "Disabled") + f" HTTP to HTTPS redirect in vibeops/{rel(conf_path)}")


def cmd_tls_acme(args: argparse.Namespace) -> None:
    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    if not conf_path.exists():
        die(f"Missing vhost: vibeops/{rel(conf_path)}")
    if args.off:
        replacement = template_text(NGINX_TEMPLATE_DIR / "tls-self-signed.conf.template", {})
        mode = "self-signed"
    else:
        replacement = template_text(NGINX_TEMPLATE_DIR / "tls-acme.conf.template", {})
        mode = "acme"
    replace_tls_block(conf_path, replacement)
    set_https_redirect(conf_path, mode == "acme" and not args.no_redirect_https)
    site = db["sites"].setdefault(main_domain, {"domain": main_domain, "vhost": rel(conf_path)})
    site["tls"] = {"mode": mode, "redirect_https": mode == "acme" and not args.no_redirect_https}
    upsert_timestamp(site)
    save_db(db)
    info(("Enabled NGINX ACME for" if mode == "acme" else "Switched to self-signed certificate for") + f" {main_domain}")
    nginx_reload(args.no_reload)


def cmd_tls_cert(args: argparse.Namespace) -> None:
    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    if not conf_path.exists():
        die(f"Missing vhost: vibeops/{rel(conf_path)}")
    cert_path = args.cert or f"/etc/letsencrypt/live/{main_domain}/fullchain.pem"
    key_path = args.key or f"/etc/letsencrypt/live/{main_domain}/privkey.pem"
    replacement = template_text(NGINX_TEMPLATE_DIR / "tls-files.conf.template", {
        "CERT_PATH": cert_path,
        "CERT_KEY_PATH": key_path,
    })
    replace_tls_block(conf_path, replacement)

    for container_path, label in [(cert_path, "cert"), (key_path, "key")]:
        if container_path.startswith("/etc/letsencrypt/"):
            host_path = CERTS_DIR / container_path.removeprefix("/etc/letsencrypt/")
            if not host_path.exists():
                warn(f"expected host {label} file vibeops/{rel(host_path)} was not found")

    site = db["sites"].setdefault(main_domain, {"domain": main_domain, "vhost": rel(conf_path)})
    site["tls"] = {"mode": "files", "cert": cert_path, "key": key_path}
    upsert_timestamp(site)
    save_db(db)
    info(f"Switched {main_domain} to certificate files:")
    info(f"  cert: {cert_path}")
    info(f"  key:  {key_path}")
    nginx_reload(args.no_reload)


def select_php_site_from_db() -> tuple[str, str, str]:
    db = load_db()
    php_sites = [
        site for site in db.get("sites", {}).values()
        if isinstance(site, dict) and site.get("type") == "php" and site.get("user") and site.get("domain")
    ]
    php_sites.sort(key=lambda s: (str(s.get("user")), str(s.get("domain"))))

    if not php_sites:
        die("No PHP sites in stack.json. Create one with: ./manage.py site create <user> <domain>")
    if len(php_sites) == 1:
        site = php_sites[0]
        return str(site["user"]), str(site["domain"]), str(site.get("php_version") or default_php_version())

    if not sys.stdin.isatty():
        choices = ", ".join(str(site.get("domain")) for site in php_sites)
        die(f"Multiple PHP sites found; choose one explicitly. Sites: {choices}")

    info("Select site:")
    for idx, site in enumerate(php_sites, start=1):
        info(f"  {idx}) {site.get('domain')}  user={site.get('user')}  php={site.get('php_version', default_php_version())}")
    while True:
        raw = input("Site number: ").strip()
        try:
            choice = int(raw)
        except ValueError:
            choice = 0
        if 1 <= choice <= len(php_sites):
            site = php_sites[choice - 1]
            return str(site["user"]), str(site["domain"]), str(site.get("php_version") or default_php_version())
        warn("invalid selection")


def cmd_app_shell(args: argparse.Namespace) -> None:
    if not args.username and not args.domain:
        args.username, args.domain, selected_php = select_php_site_from_db()
        if args.php == default_php_version():
            args.php = selected_php
    elif not args.username or not args.domain:
        die("Usage: ./manage.py shell [username domain] [--php VERSION]")
    args.command = [args.shell]
    cmd_app_exec(args)


def cmd_app_exec(args: argparse.Namespace) -> None:
    username = validate(args.username, USERNAME_RE, "username")
    domain = validate(args.domain, DOMAIN_PATH_RE, "domain/path name")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    php_service = php_service_for(php_version)
    php_cli_service = php_cli_service_for(php_version)
    app_home = f"/home/{username}"
    workdir = args.workdir or f"{app_home}/{domain}"
    command = args.command or ["sh"]
    if command and command[0] == "--":
        command = command[1:] or ["sh"]

    db = load_db()
    ensure_user(username, php_version, db)
    save_db(db)

    if not docker_available():
        die("docker is required")
    if service_running(php_service):
        run(["docker", "compose", "exec", "-T", php_service, "php-user-sync", username], check=False)

    tty_args: list[str] = []
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        tty_args.append("-T")
    os.execvp("docker", [
        "docker", "compose", "run", "--rm", *tty_args,
        php_cli_service,
        "php-cron-as", username, workdir,
        *command,
    ])


def cmd_list(args: argparse.Namespace) -> None:
    db = load_db()
    kind = args.kind
    if kind == "users":
        users = db.get("users", {})
        if not users:
            info("No users in stack.json. Create one with: ./manage.py user create <username>")
            return
        for name, user in sorted(users.items()):
            versions = ",".join(user.get("php_versions", [])) if isinstance(user, dict) else ""
            uid = user.get("uid", "") if isinstance(user, dict) else ""
            info(f"{name}\tuid={uid}\tphp={versions}")
    elif kind == "sites":
        sites = db.get("sites", {})
        if not sites:
            info("No sites in stack.json. Create one with: ./manage.py site create <user> <domain>")
            return
        for domain, site in sorted(sites.items()):
            if not isinstance(site, dict):
                continue
            if site.get("type") == "proxy":
                info(f"{domain}\tproxy\t{site.get('upstream', '')}\ttls={site.get('tls', {}).get('mode', '')}")
            else:
                info(f"{domain}\tphp\tuser={site.get('user', '')}\tphp={site.get('php_version', '')}\ttls={site.get('tls', {}).get('mode', '')}")
    elif kind == "crons":
        crons = db.get("crons", {})
        if not crons:
            info("No crons in stack.json. Create one with: ./manage.py cron create <user> <domain> <name> '<schedule>' '<command>'")
            return
        for key, cron in sorted(crons.items()):
            if not isinstance(cron, dict):
                continue
            info(f"{key}\t{cron.get('schedule', '')}\t{cron.get('command', '')}")
    else:
        print(json.dumps(db, indent=2, sort_keys=True))


def cmd_state(args: argparse.Namespace) -> None:
    if args.state_action == "path":
        info(str(DB_PATH))
    elif args.state_action == "show":
        print(json.dumps(load_db(), indent=2, sort_keys=True))
    elif args.state_action == "init":
        if DB_PATH.exists() and not args.force:
            die(f"{rel(DB_PATH)} already exists; use --force to overwrite")
        save_db({"schema": SCHEMA_VERSION, "users": {}, "sites": {}, "crons": {}})
        info(f"Initialized vibeops/{rel(DB_PATH)}")


def prompt_text(label: str, default: str | None = None, *, required: bool = True) -> str:
    suffix = f" [{default}]" if default not in (None, "") else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if not value and default is not None:
            value = default
        if value or not required:
            return value
        warn("required")


def prompt_confirm(label: str, default: bool = True) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        value = input(f"{label} [{suffix}]: ").strip().lower()
        if not value:
            return default
        if value in {"y", "yes"}:
            return True
        if value in {"n", "no"}:
            return False
        warn("answer yes or no")


def prompt_choice(label: str, choices: list[str], default: str | None = None) -> str:
    if not choices:
        return prompt_text(label, default)
    info(label + ":")
    for idx, choice in enumerate(choices, start=1):
        marker = " *" if choice == default else ""
        info(f"  {idx}) {choice}{marker}")
    while True:
        raw = input(f"Choose 1-{len(choices)}" + (f" [{default}]" if default else "") + ": ").strip()
        if not raw and default:
            return default
        try:
            idx = int(raw)
        except ValueError:
            idx = 0
        if 1 <= idx <= len(choices):
            return choices[idx - 1]
        warn("invalid selection")


def available_php_versions() -> list[str]:
    versions = sorted(p.name for p in PHP_VERSIONS_DIR.iterdir() if p.is_dir()) if PHP_VERSIONS_DIR.exists() else []
    default = default_php_version()
    if default not in versions:
        versions.insert(0, default)
    return versions


def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def print_plan(lines: list[str]) -> None:
    info("\nPlan:")
    for line in lines:
        info(f"  - {line}")


def cmd_status(args: argparse.Namespace) -> None:
    db = load_db()
    services = ["mysql57", "mysql84", "mysql97", "redis", "nginx", "php84", "php85", "php84-cron", "php85-cron"]
    running = running_services()
    info("VibeOps status\n")
    info("Docker services:")
    if not docker_available():
        info("  docker: not found")
    else:
        for service in services:
            info(f"  {service:<10} {'running' if service in running else '-'}")
    info("\nSites:")
    sites = db.get("sites", {})
    if not sites:
        info("  none")
    for domain, site in sorted(sites.items()):
        if not isinstance(site, dict):
            continue
        tls = site.get("tls", {}).get("mode", "")
        if site.get("type") == "proxy":
            info(f"  {domain:<28} proxy  {site.get('upstream', '')}  tls={tls}")
        else:
            info(f"  {domain:<28} php    user={site.get('user', '')} php={site.get('php_version', '')} tls={tls}")
    info("\nQuick checks:")
    info(f"  metadata: vibeops/{rel(DB_PATH)} {'exists' if DB_PATH.exists() else 'missing'}")
    info(f"  vhosts:   vibeops/{rel(NGINX_VHOST_DIR)}")
    if args.check_nginx and "nginx" in running:
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])


def wizard_create_user() -> None:
    username = prompt_text("Username")
    php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    uid_raw = prompt_text("UID (blank = auto)", "", required=False)
    no_mysql = not prompt_confirm("Create/update MySQL account?", True)
    mysql_service = default_mysql_service() if no_mysql else prompt_text("MySQL service", default_mysql_service())
    mysql_password = None if no_mysql else prompt_text("MySQL password (blank = generate)", "", required=False) or None
    no_reload = not prompt_confirm("Reload PHP-FPM if running?", True)
    print_plan([f"create/update user {username}", f"PHP {php}", "MySQL account: " + ("no" if no_mysql else mysql_service), "reload PHP-FPM: " + ("no" if no_reload else "yes")])
    if prompt_confirm("Continue?", True):
        cmd_user_create(argparse.Namespace(username=username, uid=int(uid_raw) if uid_raw else None, php=php, no_mysql=no_mysql, mysql_password=mysql_password, mysql_service=mysql_service, no_reload=no_reload))


def wizard_create_site() -> None:
    db = load_db()
    users = sorted(db.get("users", {}).keys())
    user_choices = users + ["+ create new user"] if users else []
    selected = prompt_choice("User", user_choices, users[0] if users else None) if user_choices else "+ create new user"
    username = prompt_text("New username") if selected == "+ create new user" else selected
    domain = prompt_text("Domain")
    aliases = parse_csv(prompt_text("Aliases, comma-separated (blank = none)", "", required=False))
    php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    db_name = prompt_text("Database suffix, e.g. app (blank = none)", "", required=False) or None
    mysql_service = prompt_text("MySQL service", default_mysql_service()) if db_name else default_mysql_service()
    no_index = not prompt_confirm("Create starter index.php if missing?", True)
    no_reload = not prompt_confirm("Reload nginx/PHP-FPM if running?", True)
    plan = [f"ensure user {username} on PHP {php}", f"create/update PHP site {domain}"]
    if aliases:
        plan.append("aliases: " + ", ".join(aliases))
    if db_name:
        plan.append(f"database: {username}_{db_name} on {mysql_service}")
    plan.append("reload services: " + ("no" if no_reload else "yes"))
    print_plan(plan)
    info("\nEquivalent command:")
    alias_args = " ".join(f"--alias {shlex.quote(a)}" for a in aliases)
    info(f"  ./manage.py site create {shlex.quote(username)} {shlex.quote(domain)}" + (f" {shlex.quote(db_name)}" if db_name else "") + f" --php {shlex.quote(php)} --mysql-service {shlex.quote(mysql_service)}" + (f" {alias_args}" if alias_args else ""))
    if prompt_confirm("Continue?", True):
        cmd_site_create(argparse.Namespace(username=username, domain=domain, db_name=db_name, php=php, mysql_service=mysql_service, alias=aliases, aliases=None, no_index=no_index, no_reload=no_reload))


def wizard_create_proxy() -> None:
    domain = prompt_text("Domain")
    upstream = prompt_text("Upstream URL", "http://127.0.0.1:3000")
    aliases = parse_csv(prompt_text("Aliases, comma-separated (blank = none)", "", required=False))
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([f"create/update proxy {domain}", f"upstream: {upstream}"] + (["aliases: " + ", ".join(aliases)] if aliases else []))
    if prompt_confirm("Continue?", True):
        cmd_proxy_create(argparse.Namespace(domain=domain, upstream=upstream, alias=aliases, aliases=None, no_reload=no_reload))


def wizard_tls_acme() -> None:
    db = load_db()
    domains = sorted(db.get("sites", {}).keys())
    domain = prompt_choice("Domain", domains) if domains else prompt_text("Domain")
    off = not prompt_confirm("Enable ACME? (no switches back to self-signed)", True)
    no_redirect_https = False if off else not prompt_confirm("Redirect HTTP to HTTPS after ACME?", True)
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([(f"switch {domain} to self-signed" if off else f"enable ACME for {domain}"), "redirect HTTP to HTTPS: " + ("no" if no_redirect_https else "yes"), "reload nginx: " + ("no" if no_reload else "yes")])
    if prompt_confirm("Continue?", True):
        cmd_tls_acme(argparse.Namespace(domain=domain, off=off, no_redirect_https=no_redirect_https, no_reload=no_reload))


def wizard_cron() -> None:
    db = load_db()
    php_sites = [s for s in db.get("sites", {}).values() if isinstance(s, dict) and s.get("type") == "php"]
    labels = [f"{s.get('user')}/{s.get('domain')} (php {s.get('php_version', default_php_version())})" for s in php_sites]
    label = prompt_choice("PHP site", labels) if labels else ""
    if label:
        site = php_sites[labels.index(label)]
        username = str(site.get("user"))
        domain = str(site.get("domain"))
        php = str(site.get("php_version") or default_php_version())
    else:
        username = prompt_text("Username")
        domain = prompt_text("Domain/path")
        php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    job_name = prompt_text("Job name")
    schedule = prompt_text("Schedule", "* * * * *")
    command = prompt_text("Command", "php artisan schedule:run")
    workdir = prompt_text("Workdir (blank = site root)", "", required=False) or None
    print_plan([f"create/update cron {username}/{domain}/{job_name}", f"schedule: {schedule}", f"command: {command}"])
    if prompt_confirm("Continue?", True):
        cmd_cron_create(argparse.Namespace(username=username, domain=domain, job_name=job_name, schedule=schedule, command=command, php=php, workdir=workdir))


def cmd_wizard(args: argparse.Namespace) -> None:
    if not sys.stdin.isatty():
        die("wizard requires an interactive terminal")
    actions = [
        "Create PHP-FPM user",
        "Create PHP site",
        "Create reverse proxy",
        "Enable/switch TLS ACME",
        "Create cron job",
        "Open app shell",
        "Show status",
        "List users/sites/crons",
        "Quit",
    ]
    while True:
        info("\nVibeOps")
        action = prompt_choice("What do you want to do?", actions)
        if action == "Create PHP-FPM user":
            wizard_create_user()
        elif action == "Create PHP site":
            wizard_create_site()
        elif action == "Create reverse proxy":
            wizard_create_proxy()
        elif action == "Enable/switch TLS ACME":
            wizard_tls_acme()
        elif action == "Create cron job":
            wizard_cron()
        elif action == "Open app shell":
            cmd_app_shell(argparse.Namespace(username=None, domain=None, php=default_php_version(), workdir=None, shell="bash"))
        elif action == "Show status":
            cmd_status(argparse.Namespace(check_nginx=False))
        elif action == "List users/sites/crons":
            kind = prompt_choice("List", ["users", "sites", "crons", "all"], "sites")
            cmd_list(argparse.Namespace(kind=kind))
        else:
            return
        if not prompt_confirm("Back to menu?", True):
            return


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="manage.py",
        description="Pure-Python management CLI for VibeOps, the vibe-coding ops stack.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.set_defaults(func=None)
    sub = parser.add_subparsers(dest="command")

    user = sub.add_parser("user", help="Manage PHP-FPM users")
    user_sub = user.add_subparsers(dest="user_command", required=True)
    user_create = user_sub.add_parser("create", help="Create/update a PHP-FPM user and pool")
    user_create.add_argument("username")
    user_create.add_argument("uid", nargs="?", type=int)
    user_create.add_argument("--php", default=default_php_version(), help="PHP version")
    user_create.add_argument("--no-mysql", action="store_true", help="Do not create/update the MySQL account")
    user_create.add_argument("--mysql-password", help="Password for the MySQL account")
    user_create.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service to create the account in, e.g. mysql57/mysql84/mysql97")
    user_create.add_argument("--no-reload", action="store_true", help="Do not reload PHP-FPM")
    user_create.set_defaults(func=cmd_user_create)

    site = sub.add_parser("site", help="Manage PHP sites")
    site_sub = site.add_subparsers(dest="site_command", required=True)
    site_create = site_sub.add_parser("create", help="Create/update a PHP vhost")
    site_create.add_argument("username")
    site_create.add_argument("domain")
    site_create.add_argument("db_name", nargs="?")
    site_create.add_argument("--php", default=default_php_version(), help="PHP version")
    site_create.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service for optional database creation, e.g. mysql57/mysql84/mysql97")
    site_create.add_argument("--alias", action="append", help="Additional server_name; can be passed multiple times or comma-separated")
    site_create.add_argument("--aliases", help="Comma-separated additional server names")
    site_create.add_argument("--no-index", action="store_true", help="Do not create starter index.php")
    site_create.add_argument("--no-reload", action="store_true", help="Do not reload nginx/PHP-FPM")
    site_create.set_defaults(func=cmd_site_create)

    proxy = sub.add_parser("proxy", help="Manage reverse proxy vhosts")
    proxy_sub = proxy.add_subparsers(dest="proxy_command", required=True)
    proxy_create = proxy_sub.add_parser("create", help="Create/update a proxy vhost")
    proxy_create.add_argument("domain")
    proxy_create.add_argument("upstream")
    proxy_create.add_argument("--alias", action="append", help="Additional server_name; can be passed multiple times or comma-separated")
    proxy_create.add_argument("--aliases", help="Comma-separated additional server names")
    proxy_create.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    proxy_create.set_defaults(func=cmd_proxy_create)

    cron = sub.add_parser("cron", help="Manage supercronic jobs")
    cron_sub = cron.add_subparsers(dest="cron_command", required=True)
    cron_create = cron_sub.add_parser("create", help="Create/update an app cron job")
    cron_create.add_argument("username")
    cron_create.add_argument("domain")
    cron_create.add_argument("job_name")
    cron_create.add_argument("schedule")
    cron_create.add_argument("command")
    cron_create.add_argument("--php", default=default_php_version(), help="PHP version")
    cron_create.add_argument("--workdir", "-w", help="Container workdir")
    cron_create.set_defaults(func=cmd_cron_create)
    cron_reload_cmd = cron_sub.add_parser("reload", help="Rebuild merged crontab and reload Supercronic")
    cron_reload_cmd.add_argument("--php", default=default_php_version(), help="PHP version")
    cron_reload_cmd.set_defaults(func=cmd_cron_reload)

    app_exec = sub.add_parser("exec", help="Run a command in an ephemeral PHP CLI container as an app user")
    app_exec.add_argument("username")
    app_exec.add_argument("domain")
    app_exec.add_argument("--php", default=default_php_version(), help="PHP version")
    app_exec.add_argument("--workdir", "-w", help="Container workdir")
    app_exec.add_argument("command", nargs=argparse.REMAINDER, help="Command to run; prefix with -- if needed")
    app_exec.set_defaults(func=cmd_app_exec)

    shell = sub.add_parser("shell", help="Open an ephemeral PHP CLI shell as an app user; with no args, choose from stack.json")
    shell.add_argument("username", nargs="?")
    shell.add_argument("domain", nargs="?")
    shell.add_argument("--php", default=default_php_version(), help="PHP version")
    shell.add_argument("--workdir", "-w", help="Container workdir")
    shell.add_argument("--shell", default="bash", help="Shell to run, default: bash")
    shell.set_defaults(func=cmd_app_shell)

    tls = sub.add_parser("tls", help="Manage vhost TLS mode")
    tls_sub = tls.add_subparsers(dest="tls_command", required=True)
    tls_acme = tls_sub.add_parser("acme", help="Enable nginx ACME for a vhost, or switch back to self-signed")
    tls_acme.add_argument("domain")
    tls_acme.add_argument("--off", "--self-signed", action="store_true", help="Switch back to the default self-signed cert")
    tls_acme.add_argument("--no-redirect-https", action="store_true", help="Do not rewrite the HTTP vhost to redirect to HTTPS after enabling ACME")
    tls_acme.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    tls_acme.set_defaults(func=cmd_tls_acme)
    tls_cert = tls_sub.add_parser("cert", help="Use explicit certificate files for a vhost")
    tls_cert.add_argument("domain")
    tls_cert.add_argument("--cert", "--fullchain")
    tls_cert.add_argument("--key", "--privkey")
    tls_cert.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    tls_cert.set_defaults(func=cmd_tls_cert)

    status = sub.add_parser("status", help="Show stack status dashboard")
    status.add_argument("--check-nginx", action="store_true", help="Run nginx -t when nginx is running")
    status.set_defaults(func=cmd_status)

    wizard = sub.add_parser("wizard", aliases=["tui"], help="Interactive guided menu for common tasks")
    wizard.set_defaults(func=cmd_wizard)

    list_cmd = sub.add_parser("list", help="List metadata from stack.json")
    list_cmd.add_argument("kind", choices=["users", "sites", "crons", "all"])
    list_cmd.set_defaults(func=cmd_list)

    state = sub.add_parser("state", help="Inspect/init the JSON metadata DB")
    state_sub = state.add_subparsers(dest="state_action", required=True)
    state_init = state_sub.add_parser("init", help="Create an empty stack.json")
    state_init.add_argument("--force", action="store_true")
    state_init.set_defaults(func=cmd_state)
    state_path = state_sub.add_parser("path", help="Print metadata DB path")
    state_path.set_defaults(func=cmd_state)
    state_show = state_sub.add_parser("show", help="Print metadata DB JSON")
    state_show.set_defaults(func=cmd_state)

    return parser


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if not argv and sys.stdin.isatty():
        argv = ["wizard"]
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.func is None:
        parser.print_help()
        return 2
    try:
        args.func(args)
        return 0
    except StackError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        print(f"error: command failed ({exc.returncode}): {' '.join(exc.cmd)}", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
