"""Argument parser construction for the VibeOps management CLI."""
from __future__ import annotations

import argparse

from vibeops.commands import *  # noqa: F403 - parser wires command callbacks by name


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="manage.py",
        description="Pure-Python management CLI for VibeOps, the vibe-coding ops stack.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.set_defaults(func=None)
    sub = parser.add_subparsers(dest="command")

    app = sub.add_parser("app", help="Manage isolated PHP apps")
    app_sub = app.add_subparsers(dest="app_command", required=True)
    app_create = app_sub.add_parser("create", help="Create/update an isolated app")
    app_create.add_argument("app_name")
    app_create.add_argument("main_domain")
    app_create.add_argument("db_suffix", nargs="?")
    app_create.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to keep an existing app's version or use the stack default for a new app",
    )
    app_create.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service for optional database creation, e.g. mysql57/mysql84/mysql97")
    app_create.add_argument("--alias", action="append", help="Additional server_name; can be passed multiple times or comma-separated")
    app_create.add_argument("--aliases", help="Comma-separated additional server names")
    app_create.add_argument("--public-dir", default="", help="Document root subdirectory inside /home/<app>/www, e.g. 'public' for Laravel; default is app root")
    app_create.add_argument("--php-entrypoint", default="auto", choices=["auto", "front-controller", "legacy"], help="PHP execution model: front-controller only runs index.php; legacy allows existing PHP scripts. auto enables front-controller when --public-dir is non-empty")
    app_create.add_argument("--no-mysql", action="store_true", help="Do not create/update the MySQL account")
    app_create.add_argument("--mysql-password", help="Password for the MySQL account")
    app_create.add_argument("--no-index", action="store_true", help="Do not create starter index.php")
    app_create.add_argument("--no-reload", action="store_true", help="Do not reload nginx/PHP-FPM")
    app_create.add_argument("--uid", type=int, help="Explicit Linux UID")
    app_create.set_defaults(func=cmd_app_create)
    app_domain = app_sub.add_parser("domain", help="Manage app domains")
    app_domain_sub = app_domain.add_subparsers(dest="domain_command", required=True)
    app_domain_list = app_domain_sub.add_parser("list", help="List an app's domains with selection numbers")
    app_domain_list.add_argument("app_name")
    app_domain_list.set_defaults(func=cmd_app_domain_list)
    app_domain_add = app_domain_sub.add_parser("add", help="Add an alias domain to an app")
    app_domain_add.add_argument("app_name")
    app_domain_add.add_argument("domain")
    app_domain_add.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_add.set_defaults(func=cmd_app_domain_add)
    app_domain_remove = app_domain_sub.add_parser("remove", aliases=["delete"], help="Remove an alias domain from an app")
    app_domain_remove.add_argument("app_name")
    app_domain_remove.add_argument("domain", nargs="?", help="Domain to remove")
    app_domain_remove.add_argument("--number", type=int, help="Number from 'app domain list'")
    app_domain_remove.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_remove.set_defaults(func=cmd_app_domain_remove)
    app_domain_main = app_domain_sub.add_parser("set-main", help="Set the app main domain")
    app_domain_main.add_argument("app_name")
    app_domain_main.add_argument("domain", nargs="?", help="Domain to make main")
    app_domain_main.add_argument("--number", type=int, help="Number from 'app domain list'")
    app_domain_main.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_main.set_defaults(func=cmd_app_domain_set_main)
    app_list = app_sub.add_parser("list", help="List apps")
    app_list.set_defaults(func=cmd_app_list)
    app_show = app_sub.add_parser("show", help="Show an app record")
    app_show.add_argument("app_name")
    app_show.set_defaults(func=cmd_app_show)
    app_db = app_sub.add_parser("db", help="List or create databases assigned to an app")
    app_db_sub = app_db.add_subparsers(dest="app_db_command", required=True)
    app_db_list = app_db_sub.add_parser("list", help="List databases recorded for an app")
    app_db_list.add_argument("app_name")
    app_db_list.set_defaults(func=cmd_app_db_list)
    app_db_create = app_db_sub.add_parser("create", help="Create an app_suffix database")
    app_db_create.add_argument("app_name")
    app_db_create.add_argument("db_suffix")
    app_db_create.add_argument("--mysql-service", help="MySQL service (defaults to the app's configured service)")
    app_db_create.set_defaults(func=cmd_app_db_create)

    user = sub.add_parser("user", help="Deprecated: manage app identities")
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

    db = sub.add_parser("db", help="Manage MySQL databases and backups")
    db_sub = db.add_subparsers(dest="db_command", required=True)

    db_list = db_sub.add_parser("list", help="List non-system databases")
    db_list.add_argument("--app", "--user", dest="app", help="Only databases for this app (prefix app_*)")
    db_list.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_list.set_defaults(func=cmd_db_list)

    db_create = db_sub.add_parser("create", help="Create app_suffix database and refresh prefix grants")
    db_create.add_argument("app_name")
    db_create.add_argument("db_suffix")
    db_create.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_create.set_defaults(func=cmd_db_create)

    db_user_reset = db_sub.add_parser("user-reset", help="Rotate an app MySQL password and rewrite credentials file")
    db_user_reset.add_argument("app_name")
    db_user_reset.add_argument("--password", help="New password (generated if omitted)")
    db_user_reset.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_user_reset.set_defaults(func=cmd_db_user_reset)

    db_shell = db_sub.add_parser("shell", help="Open an interactive mysql client (root by default)")
    db_shell.add_argument("--user", help="App MySQL user (uses runtime/home/<app>/.credentials/<service>.env)")
    db_shell.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_shell.set_defaults(func=cmd_db_shell)

    db_backup = db_sub.add_parser("backup", help="Logical dump to runtime/backups/<mysql_service>/")
    db_backup.add_argument("database", nargs="?", help="Single database name (default: all non-system DBs)")
    db_backup.add_argument("--app", "--user", dest="app", help="All databases for this app (prefix app_*)")
    db_backup.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_backup.add_argument(
        "--keep",
        type=int,
        help="After a fully successful backup batch, keep only the N newest finalized .sql files (N >= 1)",
    )
    db_backup.set_defaults(func=cmd_db_backup)

    db_restore = db_sub.add_parser("restore", help="Restore a .sql dump into a MySQL service")
    db_restore.add_argument("backup_file", help="Path or filename under runtime/backups/<service>/")
    db_restore.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_restore.add_argument("--yes", action="store_true", help="Skip interactive confirmation")
    db_restore.set_defaults(func=cmd_db_restore)

    db_list_backups = db_sub.add_parser("list-backups", help="List dumps under runtime/backups/<mysql_service>/")
    db_list_backups.add_argument("--mysql-service", default=default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_list_backups.set_defaults(func=cmd_db_list_backups)

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
    cron_create.add_argument("app_name")
    cron_create.add_argument("job_name")
    cron_create.add_argument("schedule")
    cron_create.add_argument("command")
    cron_create.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to use the app's recorded PHP version (or the stack default for a new app)",
    )
    cron_create.add_argument("--workdir", "-w", help="Workdir inside /home/<app>")
    cron_create.add_argument("--timezone", help="IANA timezone; defaults to stack TZ")
    cron_create.add_argument("--timeout", type=int, default=0, help="Kill the command after N seconds; 0 disables")
    cron_create.add_argument("--lock", help="Optional app-scoped lock shared by related jobs")
    cron_create.add_argument("--output", choices=["docker", "file"], default="docker", help="Docker logs or a private versioned file under /home/<app>/logs")
    cron_create.set_defaults(func=cmd_cron_create)
    cron_list = cron_sub.add_parser("list", help="List cron jobs with selection numbers")
    cron_list.set_defaults(func=cmd_cron_list)
    cron_remove = cron_sub.add_parser("remove", aliases=["delete"], help="Remove an app cron job and reload Supercronic")
    cron_remove.add_argument("app_name", nargs="?", help="Cron app name")
    cron_remove.add_argument("job_name", nargs="?", help="Cron job name")
    cron_remove.add_argument("--number", type=int, help="Number from 'cron list'")
    cron_remove.set_defaults(func=cmd_cron_remove)
    cron_reload_cmd = cron_sub.add_parser("reload", help="Rebuild merged crontab and reload Supercronic")
    cron_reload_cmd.add_argument("--php", default=default_php_version(), help="PHP version")
    cron_reload_cmd.set_defaults(func=cmd_cron_reload)

    app_exec = sub.add_parser("exec", help="Run a command in an ephemeral PHP CLI container as an app")
    app_exec.add_argument("app_name")
    app_exec.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to use the app's recorded PHP version (or the stack default for a new app)",
    )
    app_exec.add_argument("--workdir", "-w", help="Container workdir")
    app_exec.add_argument("command", nargs=argparse.REMAINDER, help="Command to run; prefix with -- if needed")
    app_exec.set_defaults(func=cmd_app_exec)

    shell = sub.add_parser("shell", help="Open an ephemeral PHP CLI shell as an app; with no args, choose from state")
    shell.add_argument("app_name", nargs="?")
    shell.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to use the app's recorded PHP version (or the stack default for a new app)",
    )
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

    identity = sub.add_parser("identity", help="Synchronize rendered app Linux identities")
    identity_sub = identity.add_subparsers(dest="identity_action", required=True)
    identity_sync = identity_sub.add_parser("sync", help="Create/reconcile private app users and groups in PHP containers")
    identity_sync.add_argument("app_name", nargs="?", help="App name")
    identity_sync.add_argument("--all", action="store_true", help="Synchronize all apps, grouped by PHP version")
    identity_sync.add_argument("--php", help="Override PHP version for one app")
    identity_sync.set_defaults(func=cmd_identity_sync)

    permissions = sub.add_parser("permissions", help="Check or explicitly repair app filesystem permissions")
    permissions_sub = permissions.add_subparsers(dest="permission_action", required=True)
    permissions_check = permissions_sub.add_parser("check", help="Check one app's filesystem policy")
    permissions_check.add_argument("app_name", nargs="?", help="App name")
    permissions_check.add_argument("--all", action="store_true", help="Check all apps")
    permissions_check.add_argument("--php", help="Override PHP version for one app")
    permissions_check.add_argument("--json", action="store_true", help="Emit JSON results")
    permissions_check.set_defaults(func=cmd_permissions)
    permissions_fix = permissions_sub.add_parser("fix", help="Explicitly repair one app's filesystem policy")
    permissions_fix.add_argument("app_name", nargs="?", help="App name")
    permissions_fix.add_argument("--all", action="store_true", help="Repair all apps")
    permissions_fix.add_argument("--php", help="Override PHP version for one app")
    permissions_fix.add_argument("--recursive", action="store_true", help="Repair the complete app tree")
    permissions_fix.add_argument("--dry-run", action="store_true", help="Print changes without mutating files")
    permissions_fix.add_argument("--json", action="store_true", help="Emit JSON results")
    permissions_fix.set_defaults(func=cmd_permissions)

    compose_cmd = sub.add_parser("compose", help="Run docker compose with VibeOps base plus local override files")
    compose_cmd.add_argument("compose_args", nargs=argparse.REMAINDER, help="Arguments passed to docker compose")
    compose_cmd.set_defaults(func=cmd_compose)

    render = sub.add_parser("render", help="Regenerate disposable runtime config from state")
    render.set_defaults(func=cmd_render)

    apply = sub.add_parser("apply", help="Render config, then validate/reload running services")
    apply.add_argument("--no-reload", action="store_true", help="Only render files; do not reload services")
    apply.set_defaults(func=cmd_apply)

    status = sub.add_parser("status", help="Show stack status dashboard")
    status.add_argument("--check-nginx", action="store_true", help="Run nginx -t when nginx is running")
    status.set_defaults(func=cmd_status)

    wizard = sub.add_parser("wizard", aliases=["tui"], help="Interactive guided menu for common tasks")
    wizard.set_defaults(func=cmd_wizard)

    list_cmd = sub.add_parser("list", help="List metadata from state")
    list_cmd.add_argument("kind", choices=["apps", "domains", "crons", "all", "users", "sites"])
    list_cmd.set_defaults(func=cmd_list)

    state = sub.add_parser("state", help="Inspect/init the JSON metadata DB")
    state_sub = state.add_subparsers(dest="state_action", required=True)
    state_init = state_sub.add_parser("init", help="Create an empty runtime/state/stack.json")
    state_init.add_argument("--force", action="store_true")
    state_init.set_defaults(func=cmd_state)
    state_path = state_sub.add_parser("path", help="Print metadata DB path")
    state_path.set_defaults(func=cmd_state)
    state_show = state_sub.add_parser("show", help="Print metadata DB JSON")
    state_show.set_defaults(func=cmd_state)
    state_migrate = state_sub.add_parser("migrate", help="Move/upgrade legacy ./stack.json into runtime/state/stack.json")
    state_migrate.add_argument("--force", action="store_true")
    state_migrate.set_defaults(func=cmd_state)

    return parser


