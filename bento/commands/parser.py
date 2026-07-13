"""Argument parser construction for the bento management CLI."""
from __future__ import annotations

import argparse

from bento.commands import (
    access_log_commands,
    app_commands,
    app_config_commands,
    cron_commands,
    db_commands,
    mysql_admin_commands,
    permission_commands,
    php_version_commands,
    mysql_version_commands,
    proxy_commands,
    runtime_commands,
    tls_commands,
    wizard_commands,
    worker_commands,
)
from bento.utils import env


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="manage.py",
        description="Pure-Python management CLI for bento, the vibe-coding ops stack.",
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
    app_create.add_argument(
        "--mysql-service",
        default=None,
        help="MySQL service; omit to keep an existing app's service or use the stack default for a new app",
    )
    app_create.add_argument("--alias", action="append", help="Additional server_name; can be passed multiple times or comma-separated")
    app_create.add_argument("--aliases", help="Comma-separated additional server names")
    app_create.add_argument("--public-dir", default="", help="Document root subdirectory inside /home/<app>/www, e.g. 'public' for Laravel; default is app root")
    app_create.add_argument("--php-entrypoint", default="auto", choices=["auto", "front-controller", "legacy"], help="PHP execution model: front-controller only runs index.php; legacy allows existing PHP scripts. auto enables front-controller when --public-dir is non-empty")
    app_create.add_argument(
        "--fpm-profile",
        default=None,
        choices=list(env.FPM_PROFILE_NAMES),
        help="PHP-FPM pool profile (ondemand|balanced|throughput); omit to keep an existing app's profile or use DEFAULT_FPM_PROFILE for a new app",
    )
    app_create.add_argument("--no-mysql", action="store_true", help="Do not create/update the MySQL account")
    app_create.add_argument(
        "--mysql-password",
        help="Password for the MySQL account (discouraged: visible in shell history/process list; omit to auto-generate)",
    )
    app_create.add_argument("--no-index", action="store_true", help="Do not create starter index.php")
    app_create.add_argument("--no-reload", action="store_true", help="Do not reload nginx/PHP-FPM")
    app_create.add_argument("--uid", type=int, help="Explicit Linux UID")
    app_create.add_argument(
        "--access-log",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Enable (or --no-access-log disable) app-scoped nginx access logging",
    )
    app_create.set_defaults(func=app_commands.cmd_app_create)
    app_domain = app_sub.add_parser("domain", help="Manage app domains")
    app_domain_sub = app_domain.add_subparsers(dest="domain_command", required=True)
    app_domain_list = app_domain_sub.add_parser("list", help="List an app's domains with selection numbers")
    app_domain_list.add_argument("app_name")
    app_domain_list.set_defaults(func=app_commands.cmd_app_domain_list)
    app_domain_add = app_domain_sub.add_parser("add", help="Add an alias domain to an app")
    app_domain_add.add_argument("app_name")
    app_domain_add.add_argument("domain")
    app_domain_add.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_add.set_defaults(func=app_commands.cmd_app_domain_add)
    app_domain_remove = app_domain_sub.add_parser("remove", aliases=["delete"], help="Remove an alias domain from an app")
    app_domain_remove.add_argument("app_name")
    app_domain_remove.add_argument("domain", nargs="?", help="Domain to remove")
    app_domain_remove.add_argument("--number", type=int, help="Number from 'app domain list'")
    app_domain_remove.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_remove.set_defaults(func=app_commands.cmd_app_domain_remove)
    app_domain_main = app_domain_sub.add_parser("set-main", help="Set the app main domain")
    app_domain_main.add_argument("app_name")
    app_domain_main.add_argument("domain", nargs="?", help="Domain to make main")
    app_domain_main.add_argument("--number", type=int, help="Number from 'app domain list'")
    app_domain_main.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    app_domain_main.set_defaults(func=app_commands.cmd_app_domain_set_main)
    app_list = app_sub.add_parser("list", help="List apps")
    app_list.set_defaults(func=app_commands.cmd_app_list)
    app_show = app_sub.add_parser("show", help="Show an app record")
    app_show.add_argument("app_name")
    app_show.set_defaults(func=app_commands.cmd_app_show)
    app_db = app_sub.add_parser("db", help="List or create databases assigned to an app")
    app_db_sub = app_db.add_subparsers(dest="app_db_command", required=True)
    app_db_list = app_db_sub.add_parser("list", help="List databases recorded for an app")
    app_db_list.add_argument("app_name")
    app_db_list.set_defaults(func=app_commands.cmd_app_db_list)
    app_db_create = app_db_sub.add_parser("create", help="Create an app_suffix database")
    app_db_create.add_argument("app_name")
    app_db_create.add_argument("db_suffix")
    app_db_create.add_argument("--mysql-service", help="MySQL service (defaults to the app's configured service)")
    app_db_create.set_defaults(func=app_commands.cmd_app_db_create)
    app_config = app_sub.add_parser("config", help="Manage app-scoped service template customization")
    app_config_sub = app_config.add_subparsers(dest="app_config_command", required=True)
    app_config_customize = app_config_sub.add_parser("customize", help="Copy and activate an app-owned service template")
    app_config_customize.add_argument("app_name")
    app_config_customize.add_argument("target", choices=["vhost", "pool"])
    app_config_customize.add_argument("--force", action="store_true", help="Replace an existing custom source with the current upstream template")
    app_config_customize.add_argument("--no-edit", action="store_true", help="Activate without opening VISUAL, EDITOR, or vi")
    app_config_customize.add_argument("--no-reload", action="store_true", help="Validate but do not reload the affected service")
    app_config_customize.set_defaults(func=app_config_commands.cmd_app_config_customize)
    app_config_reset = app_config_sub.add_parser("reset", help="Switch back to the upstream generated template")
    app_config_reset.add_argument("app_name")
    app_config_reset.add_argument("target", choices=["vhost", "pool"])
    app_config_reset.add_argument("--no-reload", action="store_true", help="Validate but do not reload the affected service")
    app_config_reset.set_defaults(func=app_config_commands.cmd_app_config_reset)
    app_config_status = app_config_sub.add_parser("status", help="Show app service template ownership")
    app_config_status.add_argument("app_name")
    app_config_status.set_defaults(func=app_config_commands.cmd_app_config_status)

    app_access_log = app_sub.add_parser("access-log", help="Enable/disable app-scoped nginx access logs")
    app_access_log_sub = app_access_log.add_subparsers(dest="access_log_action", required=True)
    for action, help_text in (
        ("enable", "Write Combined access logs under runtime/logs/nginx/apps/"),
        ("disable", "Stop writing access logs for this app (files are kept)"),
        ("status", "Show access-log flag and log files for this app"),
    ):
        p = app_access_log_sub.add_parser(action, help=help_text)
        p.add_argument("app_name")
        if action in {"enable", "disable"}:
            p.add_argument("--no-reload", action="store_true", help="Render but do not validate/reload nginx")
        p.set_defaults(func=access_log_commands.cmd_app_access_log)

    app_logs = app_sub.add_parser("logs", help="App log utilities")
    app_logs_sub = app_logs.add_subparsers(dest="app_logs_command", required=True)
    app_logs_analyze = app_logs_sub.add_parser(
        "analyze",
        help="Adhoc GoAccess analysis of app nginx access logs (Docker one-shot; not realtime)",
    )
    app_logs_analyze.add_argument("app_name")
    app_logs_analyze.add_argument(
        "--html",
        help="Write a static HTML report to this path (required when not on a TTY)",
    )
    app_logs_analyze.set_defaults(func=access_log_commands.cmd_app_logs_analyze)

    db = sub.add_parser("db", help="Manage MySQL databases and backups")
    db_sub = db.add_subparsers(dest="db_command", required=True)

    db_list = db_sub.add_parser("list", help="List non-system databases")
    db_list.add_argument("--app", "--user", dest="app", help="Only databases for this app (prefix app_*)")
    db_list.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_list.set_defaults(func=db_commands.cmd_db_list)

    db_create = db_sub.add_parser("create", help="Create app_suffix database and refresh prefix grants")
    db_create.add_argument("app_name")
    db_create.add_argument("db_suffix")
    db_create.add_argument("--mysql-service", default=None, help="MySQL service (must match the app's configured service)")
    db_create.set_defaults(func=db_commands.cmd_db_create)

    db_user_reset = db_sub.add_parser("user-reset", help="Rotate an app MySQL password and rewrite credentials file")
    db_user_reset.add_argument("app_name")
    db_user_reset.add_argument(
        "--password",
        help="New password (discouraged: visible in shell history/process list; omit to auto-generate)",
    )
    db_user_reset.add_argument("--mysql-service", default=None, help="MySQL service (must match the app's configured service)")
    db_user_reset.set_defaults(func=db_commands.cmd_db_user_reset)

    db_shell = db_sub.add_parser("shell", help="Open an interactive mysql client (root by default)")
    db_shell.add_argument("--user", help="App MySQL user (uses runtime/home/<app>/.credentials/<service>.env)")
    db_shell.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_shell.set_defaults(func=db_commands.cmd_db_shell)

    db_stats = db_sub.add_parser("stats", help="Show table counts and allocated size per database")
    db_stats.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_stats.set_defaults(func=mysql_admin_commands.cmd_db_stats)

    db_process_list = db_sub.add_parser("process-list", aliases=["processlist"], help="Show current MySQL sessions and queries")
    db_process_list.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_process_list.set_defaults(func=mysql_admin_commands.cmd_db_process_list)

    db_backup = db_sub.add_parser("backup", help="Logical dump to runtime/backups/<mysql_service>/")
    db_backup.add_argument("database", nargs="?", help="Single database name (default: all non-system DBs)")
    db_backup.add_argument("--app", "--user", dest="app", help="All databases for this app (prefix app_*)")
    db_backup.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_backup.add_argument(
        "--gzip",
        action="store_true",
        help="Stream mysqldump through gzip and write .sql.gz (atomic promote; smaller on disk)",
    )
    db_backup.add_argument(
        "--keep",
        type=int,
        help="After a fully successful backup batch, keep only the N newest finalized .sql/.sql.gz files (N >= 1)",
    )
    db_backup.set_defaults(func=db_commands.cmd_db_backup)

    db_restore = db_sub.add_parser("restore", help="Restore a .sql or .sql.gz dump into a MySQL service")
    db_restore.add_argument("backup_file", help="Path or filename under runtime/backups/<service>/ (.sql or .sql.gz)")
    db_restore.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_restore.add_argument("--yes", action="store_true", help="Skip interactive confirmation")
    db_restore.set_defaults(func=db_commands.cmd_db_restore)

    db_list_backups = db_sub.add_parser("list-backups", help="List finalized .sql/.sql.gz dumps under runtime/backups/<mysql_service>/")
    db_list_backups.add_argument("--mysql-service", default=env.default_mysql_service(), help="MySQL service, e.g. mysql57/mysql84/mysql97")
    db_list_backups.set_defaults(func=db_commands.cmd_db_list_backups)

    proxy = sub.add_parser("proxy", help="Manage reverse proxy vhosts")
    proxy_sub = proxy.add_subparsers(dest="proxy_command", required=True)
    proxy_create = proxy_sub.add_parser("create", help="Create/update a proxy vhost")
    proxy_create.add_argument("domain")
    proxy_create.add_argument("upstream")
    proxy_create.add_argument("--alias", action="append", help="Additional server_name; can be passed multiple times or comma-separated")
    proxy_create.add_argument("--aliases", help="Comma-separated additional server names")
    proxy_create.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    proxy_create.set_defaults(func=proxy_commands.cmd_proxy_create)

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
    cron_create.set_defaults(func=cron_commands.cmd_cron_create)
    cron_list = cron_sub.add_parser("list", help="List cron jobs with selection numbers")
    cron_list.add_argument("--app", dest="app_name", help="Only cron jobs for this app")
    cron_list.set_defaults(func=cron_commands.cmd_cron_list)
    cron_remove = cron_sub.add_parser("remove", aliases=["delete"], help="Remove an app cron job and reload Supercronic")
    cron_remove.add_argument("app_name", nargs="?", help="Cron app name")
    cron_remove.add_argument("job_name", nargs="?", help="Cron job name")
    cron_remove.add_argument("--number", type=int, help="Number from 'cron list'")
    cron_remove.set_defaults(func=cron_commands.cmd_cron_remove)
    cron_reload_cmd = cron_sub.add_parser("reload", help="Regenerate and reload per-app Supercronic schedulers")
    cron_reload_cmd.add_argument("--php", default=env.default_php_version(), help="PHP version")
    cron_reload_cmd.add_argument("--app", dest="app_name", help="Require this app to have cron jobs")
    cron_reload_cmd.set_defaults(func=cron_commands.cmd_cron_reload)

    worker_commands.add_parser(sub)
    php_version_commands.add_parser(sub)
    mysql_version_commands.add_parser(sub)

    app_exec = sub.add_parser("exec", help="Run a command in an ephemeral PHP CLI container as an app")
    app_exec.add_argument("app_name")
    app_exec.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to use the app's recorded PHP version (or the stack default for a new app)",
    )
    app_exec.add_argument("--workdir", "-w", help="Container workdir")
    app_exec.add_argument("command", nargs=argparse.REMAINDER, help="Command to run; prefix with -- if needed")
    app_exec.set_defaults(func=runtime_commands.cmd_app_exec)

    shell = sub.add_parser("shell", help="Open an ephemeral PHP CLI shell as an app; with no args, choose from state")
    shell.add_argument("app_name", nargs="?")
    shell.add_argument(
        "--php",
        default=None,
        help="PHP version; omit to use the app's recorded PHP version (or the stack default for a new app)",
    )
    shell.add_argument("--workdir", "-w", help="Container workdir")
    shell.add_argument("--shell", default="bash", help="Shell to run, default: bash")
    shell.set_defaults(func=runtime_commands.cmd_app_shell)

    tls = sub.add_parser("tls", help="Manage vhost TLS mode")
    tls_sub = tls.add_subparsers(dest="tls_command", required=True)
    tls_acme = tls_sub.add_parser("acme", help="Enable nginx ACME for a vhost, or switch back to self-signed")
    tls_acme.add_argument("domain")
    tls_acme.add_argument("--off", "--self-signed", action="store_true", help="Switch back to the default self-signed cert")
    tls_acme.add_argument("--no-redirect-https", action="store_true", help="Do not rewrite the HTTP vhost to redirect to HTTPS after enabling ACME")
    tls_acme.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    tls_acme.set_defaults(func=tls_commands.cmd_tls_acme)
    tls_cert = tls_sub.add_parser("cert", help="Use explicit certificate files for a vhost")
    tls_cert.add_argument("domain")
    tls_cert.add_argument("--cert", "--fullchain")
    tls_cert.add_argument("--key", "--privkey")
    tls_cert.add_argument("--no-reload", action="store_true", help="Do not reload nginx")
    tls_cert.set_defaults(func=tls_commands.cmd_tls_cert)

    identity = sub.add_parser("identity", help="Synchronize rendered app Linux identities")
    identity_sub = identity.add_subparsers(dest="identity_action", required=True)
    identity_sync = identity_sub.add_parser("sync", help="Create/reconcile private app users and groups in PHP containers")
    identity_sync.add_argument("app_name", nargs="?", help="App name")
    identity_sync.add_argument("--all", action="store_true", help="Synchronize all apps, grouped by PHP version")
    identity_sync.add_argument("--php", help="Override PHP version for one app")
    identity_sync.set_defaults(func=permission_commands.cmd_identity_sync)

    permissions = sub.add_parser("permissions", help="Check or explicitly repair app filesystem permissions")
    permissions_sub = permissions.add_subparsers(dest="permission_action", required=True)
    permissions_check = permissions_sub.add_parser("check", help="Check one app's filesystem policy")
    permissions_check.add_argument("app_name", nargs="?", help="App name")
    permissions_check.add_argument("--all", action="store_true", help="Check all apps")
    permissions_check.add_argument("--php", help="Override PHP version for one app")
    permissions_check.add_argument("--json", action="store_true", help="Emit JSON results")
    permissions_check.set_defaults(func=permission_commands.cmd_permissions)
    permissions_fix = permissions_sub.add_parser("fix", help="Explicitly repair one app's filesystem policy")
    permissions_fix.add_argument("app_name", nargs="?", help="App name")
    permissions_fix.add_argument("--all", action="store_true", help="Repair all apps")
    permissions_fix.add_argument("--php", help="Override PHP version for one app")
    permissions_fix.add_argument("--recursive", action="store_true", help="Repair the complete app tree")
    permissions_fix.add_argument("--dry-run", action="store_true", help="Print changes without mutating files")
    permissions_fix.add_argument("--json", action="store_true", help="Emit JSON results")
    permissions_fix.set_defaults(func=permission_commands.cmd_permissions)

    compose_cmd = sub.add_parser("compose", help="Run docker compose with bento base plus local override files")
    compose_cmd.add_argument("compose_args", nargs=argparse.REMAINDER, help="Arguments passed to docker compose")
    compose_cmd.set_defaults(func=runtime_commands.cmd_compose)

    render = sub.add_parser("render", help="Regenerate disposable runtime config from state")
    render.set_defaults(func=runtime_commands.cmd_render)

    apply = sub.add_parser("apply", help="Render config, then validate/reload running services")
    apply.add_argument("--no-reload", action="store_true", help="Only render files; do not reload services")
    apply.set_defaults(func=runtime_commands.cmd_apply)

    logs_cmd = sub.add_parser("logs", help="Rotate and manage stack file logs")
    logs_sub = logs_cmd.add_subparsers(dest="logs_command", required=True)
    logs_rotate = logs_sub.add_parser(
        "rotate",
        help="Rotate oversized app nginx access logs (rename + nginx -s reopen; never reloads config)",
    )
    logs_rotate.add_argument(
        "--force",
        action="store_true",
        help="Rotate live access logs even when under NGINX_ACCESS_LOG_MAX_SIZE",
    )
    logs_rotate.add_argument(
        "--app",
        dest="app_name",
        help="Only rotate this app's access log",
    )
    logs_rotate.set_defaults(func=access_log_commands.cmd_logs_rotate)

    status = sub.add_parser("status", help="Show stack status dashboard")
    status.add_argument("--check-nginx", action="store_true", help="Run nginx -t when nginx is running")
    status.set_defaults(func=runtime_commands.cmd_status)

    wizard = sub.add_parser("wizard", aliases=["tui"], help="Interactive guided menu for common tasks")
    wizard.set_defaults(func=wizard_commands.cmd_wizard)

    list_cmd = sub.add_parser("list", help="List metadata from state")
    list_cmd.add_argument("kind", choices=["apps", "domains", "crons", "workers", "all"])
    list_cmd.set_defaults(func=runtime_commands.cmd_list)

    state = sub.add_parser("state", help="Inspect/init the JSON metadata DB")
    state_sub = state.add_subparsers(dest="state_action", required=True)
    state_init = state_sub.add_parser("init", help="Create an empty runtime/state/stack.json")
    state_init.add_argument("--force", action="store_true")
    state_init.set_defaults(func=runtime_commands.cmd_state)
    state_path = state_sub.add_parser("path", help="Print metadata DB path")
    state_path.set_defaults(func=runtime_commands.cmd_state)
    state_show = state_sub.add_parser("show", help="Print metadata DB JSON")
    state_show.set_defaults(func=runtime_commands.cmd_state)

    return parser
