"""App and domain commands."""
from __future__ import annotations

import argparse
import json
from typing import Any

from bento.utils.env import default_fpm_profile, default_mysql_service, default_php_version, validate_fpm_profile
from bento.utils.errors import die, info, warn_password_cli_flag
from bento.os.fsutil import mkdir
from bento.services.mysql import apply_app_mysql_metadata, ensure_mysql_database, require_mysql_ready_for_sql
from bento.services.nginx import app_vhost_path, assert_domain_free, domains_for, nginx_reload, normalize_aliases
from bento.utils.paths import PHP_TEMPLATE_DIR, rel
from bento.commands.permission_commands import initialize_app_permissions
from bento.services.php import app_document_root, ensure_app_identity, php_service_for, php_version_config_dir
from bento.services.rendering import write_template
from bento.services.state import load_db, save_db, serialized_cron_state, upsert_timestamp
from bento.ui.table import print_table
from bento.utils.validation import (
    APP_NAME_RE, DB_NAME_RE, DOMAIN_RE, MYSQL_SERVICE_RE,
    PHP_VERSION_RE, validate, validate_php_entrypoint, validate_public_dir
)

def resolve_app_php_version(
    db: dict[str, Any],
    app_name: str,
    requested: str | None = None,
    *,
    allow_new: bool = True,
) -> str:
    """Resolve the PHP version for an app-scoped command without mutating state.

    Omitted ``requested`` uses the app's recorded primary version (or the stack
    default for a new app when ``allow_new``). An explicit mismatched version is
    rejected; intentional primary-runtime migration is ``app create --php``.
    """
    apps = db.get("apps") if isinstance(db, dict) else None
    existing = apps.get(app_name) if isinstance(apps, dict) else None
    if isinstance(existing, dict):
        recorded_raw = existing.get("php_version")
        if recorded_raw is None or recorded_raw == "":
            die(f"App {app_name} has no recorded php_version in state")
        recorded = validate(str(recorded_raw), PHP_VERSION_RE, "PHP version")
        if requested is None:
            return recorded
        requested_version = validate(str(requested), PHP_VERSION_RE, "PHP version")
        if requested_version != recorded:
            die(
                f"App {app_name} primary PHP version is {recorded}, not {requested_version}. "
                f"Re-run ./manage.py app create {app_name} <main-domain> --php {requested_version} "
                f"to migrate the primary runtime intentionally."
            )
        return requested_version

    if not allow_new:
        die(f"Unknown app: {app_name}")
    if requested is None:
        return validate(default_php_version(), PHP_VERSION_RE, "PHP version")
    return validate(str(requested), PHP_VERSION_RE, "PHP version")

def resolve_app_fpm_profile(
    db: dict[str, Any],
    app_name: str,
    requested: str | None = None,
    *,
    allow_new: bool = True,
) -> str:
    """Resolve FPM profile: explicit flag, else recorded profile, else stack default."""
    apps = db.get("apps") if isinstance(db, dict) else None
    existing = apps.get(app_name) if isinstance(apps, dict) else None
    if requested is not None:
        return validate_fpm_profile(str(requested))
    if isinstance(existing, dict):
        recorded = existing.get("fpm_profile")
        if recorded is not None and str(recorded).strip() != "":
            return validate_fpm_profile(str(recorded))
        return default_fpm_profile()
    if not allow_new:
        die(f"Unknown app: {app_name}")
    return default_fpm_profile()

def cmd_app_create(args: argparse.Namespace) -> None:
    if getattr(args, "mysql_password", None):
        warn_password_cli_flag("--mysql-password")
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    main_domain = validate(args.main_domain, DOMAIN_RE, "main domain")
    # Explicit --php is the intentional migration path; omitted preserves recorded version.
    if getattr(args, "php", None) is None:
        php_version = resolve_app_php_version(db, app_name, None, allow_new=True)
    else:
        php_version = validate(str(args.php), PHP_VERSION_RE, "PHP version")
    mysql_service = validate(args.mysql_service, MYSQL_SERVICE_RE, "MySQL service")
    if args.no_mysql and args.db_suffix:
        die("Cannot create a database suffix with --no-mysql")
    # Explicit database intent must succeed or fail before local app side effects.
    if args.db_suffix:
        validate(args.db_suffix, DB_NAME_RE, "database suffix")
        require_mysql_ready_for_sql(mysql_service)
    public_dir = validate_public_dir(getattr(args, "public_dir", ""))
    php_entrypoint = validate_php_entrypoint(getattr(args, "php_entrypoint", "auto"), public_dir)
    fpm_profile = resolve_app_fpm_profile(db, app_name, getattr(args, "fpm_profile", None), allow_new=True)
    aliases = normalize_aliases(args.alias, args.aliases)
    all_domains = domains_for(main_domain, aliases)
    for domain in all_domains:
        assert_domain_free(domain, db, allow_app=app_name)

    app = ensure_app_identity(
        app_name,
        php_version,
        db,
        uid=args.uid,
        public_dir=public_dir,
        fpm_profile=fpm_profile,
        no_mysql=args.no_mysql,
        mysql_password=getattr(args, "mysql_password", None),
        mysql_service=mysql_service,
        no_reload=args.no_reload,
    )
    if app.get("main_domain") and app.get("main_domain") != main_domain:
        die(f"App {app_name} already has main domain {app.get('main_domain')}; use app domain set-main")
    old_domains = set(app.get("domains") or [])
    app["main_domain"] = main_domain
    app["domains"] = all_domains
    app["public_dir"] = public_dir
    app["php_entrypoint"] = php_entrypoint
    app["fpm_profile"] = fpm_profile
    if getattr(args, "access_log", None) is not None:
        app["access_log"] = bool(args.access_log)
    else:
        app.setdefault("access_log", False)
    app["root"] = rel(app_document_root(app_name, public_dir))
    mkdir(app_document_root(app_name, public_dir))
    if app.get("access_log"):
        from bento.services.access_log import ensure_access_log_dir

        ensure_access_log_dir()
    for old_domain in old_domains - set(all_domains):
        owner = db.get("domains", {}).get(old_domain)
        if owner and owner.get("kind") == "php" and owner.get("app") == app_name:
            db["domains"].pop(old_domain, None)
    apply_app_mysql_metadata(app, app_name, mysql_service, app.get("mysql_credentials"))

    index_path = app_document_root(app_name, public_dir) / "index.php"
    if not args.no_index and not index_path.exists():
        write_template(index_path, PHP_TEMPLATE_DIR / "index.php.template", {"MAIN_DOMAIN": main_domain, "PHP_VERSION": php_version})

    if args.db_suffix:
        db_full_name = ensure_mysql_database(app_name, args.db_suffix, mysql_service)
        if db_full_name not in app.setdefault("databases", []):
            app["databases"].append(db_full_name)
        app.setdefault("database_services", {})[db_full_name] = mysql_service

    for domain in all_domains:
        db["domains"][domain] = {"kind": "php", "app": app_name}
    upsert_timestamp(app)
    from bento.commands.runtime_commands import apply_generated_config
    apply_generated_config(db, reload_services=False, validate_services=False)
    conf_path = app_vhost_path(app_name)
    save_db(db)
    # App creation is the one safe time to repair the entire (small) initial tree.
    # Later deploys must opt into a recursive repair explicitly.
    initialize_app_permissions(app_name, php_version)

    info(f"Created HTTP+HTTPS app vhost: bento/{rel(conf_path)}")
    info(f"Document root: bento/{rel(app_document_root(app_name, public_dir))}")
    info(f"PHP entrypoint: {php_entrypoint}")
    info(f"PHP-FPM profile: {fpm_profile}")
    info(f"Access log: {'on' if app.get('access_log') else 'off'}")
    info(f"PHP-FPM: {php_version} via /run/php-fpm/{php_service_for(php_version)}/{app_name}.sock")
    nginx_reload(args.no_reload)

def ensure_app(app_name: str, php_version: str, db: dict[str, Any], no_reload: bool = False, mysql_service: str | None = None) -> dict[str, Any]:
    existing = db.get("apps", {}).get(app_name)
    if isinstance(existing, dict):
        recorded_raw = existing.get("php_version")
        if recorded_raw is not None and str(recorded_raw) != "":
            recorded = str(recorded_raw)
            if recorded != php_version:
                die(
                    f"App {app_name} primary PHP version is {recorded}, not {php_version}. "
                    f"Re-run ./manage.py app create {app_name} <main-domain> --php {php_version} "
                    f"to migrate the primary runtime intentionally."
                )
        if (php_version_config_dir(php_version) / "users.d" / f"{app_name}.env").exists():
            return existing
    info(f"PHP {php_version} app identity {app_name} does not exist; creating it first.")
    return ensure_app_identity(app_name, php_version, db, mysql_service=mysql_service, no_reload=no_reload)

def cmd_app_domain_list(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict) or not app.get("main_domain"):
        die(f"Unknown app or app has no vhost: {app_name}")
    domains = list(dict.fromkeys(app.get("domains") or [app["main_domain"]]))
    rows = [
        [str(index), domain, "main" if domain == app.get("main_domain") else ""]
        for index, domain in enumerate(domains, start=1)
    ]
    print_table(rows, headers=["#", "DOMAIN", "ROLE"])

@serialized_cron_state
def cmd_app_domain_add(args: argparse.Namespace) -> None:
    from bento.commands.runtime_commands import SERVICE_TARGETS_NGINX, apply_generated_config

    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    domain = validate(args.domain, DOMAIN_RE, "domain")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict) or not app.get("main_domain"):
        die(f"Unknown app or app has no vhost: {app_name}")
    assert_domain_free(domain, db, allow_app=app_name)
    domains = list(app.get("domains") or [app["main_domain"]])
    if domain not in domains:
        domains.append(domain)
    app["domains"] = domains
    db["domains"][domain] = {"kind": "php", "app": app_name}
    upsert_timestamp(app)
    # Domain aliases only change the nginx vhost server_name list; PHP pool and
    # cron are unchanged and must not be reloaded.
    apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
        service_targets=SERVICE_TARGETS_NGINX,
    )
    save_db(db)
    info(f"Added domain {domain} to app {app_name}")

def app_domain_from_args(args: argparse.Namespace, app: dict[str, Any]) -> str:
    number = getattr(args, "number", None)
    if number is not None:
        if getattr(args, "domain", None):
            die("Provide either a domain or --number, not both")
        domains = [domain for domain in dict.fromkeys(app.get("domains") or [app.get("main_domain")]) if isinstance(domain, str) and domain]
        if not 1 <= number <= len(domains):
            die(f"Invalid domain number: {number}")
        return domains[number - 1]
    if not getattr(args, "domain", None):
        die("Provide a domain or --number from 'app domain list'")
    return validate(args.domain, DOMAIN_RE, "domain")

@serialized_cron_state
def cmd_app_domain_remove(args: argparse.Namespace) -> None:
    from bento.commands.runtime_commands import SERVICE_TARGETS_NGINX, apply_generated_config

    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    domain = app_domain_from_args(args, app)
    if domain == app.get("main_domain"):
        die("Cannot remove the main domain; use app domain set-main first")
    domains = [d for d in app.get("domains", []) if d != domain]
    if len(domains) == len(app.get("domains", [])):
        die(f"Domain {domain} is not on app {app_name}")
    app["domains"] = domains
    db.get("domains", {}).pop(domain, None)
    upsert_timestamp(app)
    apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
        service_targets=SERVICE_TARGETS_NGINX,
    )
    save_db(db)
    info(f"Removed domain {domain} from app {app_name}")

@serialized_cron_state
def cmd_app_domain_set_main(args: argparse.Namespace) -> None:
    from bento.commands.runtime_commands import SERVICE_TARGETS_NGINX, apply_generated_config

    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    domain = app_domain_from_args(args, app)
    domains = list(app.get("domains") or [])
    if domain not in domains:
        die(f"Domain {domain} is not on app {app_name}; add it first")
    app["main_domain"] = domain
    app["domains"] = [domain] + [d for d in domains if d != domain]
    upsert_timestamp(app)
    apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
        service_targets=SERVICE_TARGETS_NGINX,
    )
    save_db(db)
    info(f"Set main domain for {app_name}: {domain}")

def cmd_app_db_list(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    databases = list(dict.fromkeys(app.get("databases") or []))
    if not databases:
        info(f"No databases recorded for app {app_name}.")
        return
    services = app.get("database_services") or {}
    rows = []
    for index, database in enumerate(databases, start=1):
        service = services.get(database) or app.get("mysql_service") or default_mysql_service()
        rows.append([str(index), database, service])
    print_table(rows, headers=["#", "DATABASE", "SERVICE"])

def cmd_app_db_create(args: argparse.Namespace) -> None:
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    db = load_db()
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    suffix = validate(args.db_suffix, DB_NAME_RE, "database suffix")
    service = validate(args.mysql_service or str(app.get("mysql_service") or default_mysql_service()), MYSQL_SERVICE_RE, "MySQL service")
    db_full_name = ensure_mysql_database(app_name, suffix, service)
    if db_full_name not in app.setdefault("databases", []):
        app["databases"].append(db_full_name)
    app.setdefault("database_services", {})[db_full_name] = service
    upsert_timestamp(app)
    save_db(db)

def cmd_app_list(args: argparse.Namespace) -> None:
    db = load_db()
    apps = db.get("apps", {})
    if not apps:
        info("No apps in stack.json. Create one with: ./manage.py app create <app_name> <main_domain>")
        return
    rows: list[list[str]] = []
    for name, app in sorted(apps.items()):
        if not isinstance(app, dict):
            continue
        domains = ",".join(app.get("domains", []) or [])
        rows.append(
            [
                name,
                str(app.get("php_version", "") or ""),
                str(app.get("fpm_profile", "") or ""),
                str(app.get("php_entrypoint", "") or ""),
                "on" if app.get("access_log") else "off",
                str(app.get("main_domain", "") or ""),
                domains,
            ]
        )
    print_table(rows, headers=["APP", "PHP", "FPM", "ENTRYPOINT", "ACCESS", "MAIN", "DOMAINS"])

def cmd_app_show(args: argparse.Namespace) -> None:
    db = load_db()
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict):
        die(f"Unknown app: {app_name}")
    print(json.dumps(app, indent=2, sort_keys=True))
