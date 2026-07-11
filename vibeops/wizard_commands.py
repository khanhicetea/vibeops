"""Interactive wizard commands."""
from __future__ import annotations

import argparse
import shlex
import sys

from vibeops.helpers import *  # noqa: F403
from vibeops.app_commands import (
    cmd_app_create,
    cmd_app_db_create,
    cmd_app_db_list,
    cmd_app_domain_add,
    cmd_app_domain_list,
    cmd_app_domain_remove,
    cmd_app_domain_set_main,
    cmd_user_create,
)
from vibeops.cron_commands import cmd_cron_create, cmd_cron_list, cmd_cron_remove
from vibeops.proxy_commands import cmd_proxy_create
from vibeops.permission_commands import cmd_permissions
from vibeops.runtime_commands import *  # noqa: F403
from vibeops.tls_commands import cmd_tls_acme

def wizard_create_user() -> None:
    username = prompt_validated("App name", APP_NAME_RE, "app_name", hint="use a Linux-safe slug like my_app or shop-api; lowercase, no spaces, max 32 chars")
    php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    uid = prompt_int("UID (blank = auto)", "", required=False)
    no_mysql = not prompt_confirm("Create/update MySQL account?", True)
    mysql_service = default_mysql_service() if no_mysql else prompt_validated("MySQL service", MYSQL_SERVICE_RE, "MySQL service", default_mysql_service(), hint="for example mysql57, mysql84, mysql97")
    mysql_password = None if no_mysql else prompt_text("MySQL password (blank = generate)", "", required=False) or None
    no_reload = not prompt_confirm("Reload PHP-FPM if running?", True)
    print_plan([f"create/update app identity {username}", f"PHP {php}", "MySQL account: " + ("no" if no_mysql else mysql_service), "reload PHP-FPM: " + ("no" if no_reload else "yes")])
    if prompt_confirm("Continue?", True):
        cmd_user_create(argparse.Namespace(username=username, uid=uid, php=php, no_mysql=no_mysql, mysql_password=mysql_password, mysql_service=mysql_service, no_reload=no_reload))



def wizard_create_site() -> None:
    app_name = prompt_validated("App name", APP_NAME_RE, "app_name", hint="use a Linux-safe slug like my_app or shop-api; lowercase, no spaces, max 32 chars")
    domain = prompt_validated("Main domain", DOMAIN_RE, "domain")
    aliases = prompt_aliases()
    public_dir = prompt_public_dir()
    php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    db_name = prompt_validated("Database suffix, e.g. app (blank = none)", DB_NAME_RE, "database suffix", "", required=False) or None
    mysql_service = prompt_validated("MySQL service", MYSQL_SERVICE_RE, "MySQL service", default_mysql_service(), hint="for example mysql57, mysql84, mysql97") if db_name else default_mysql_service()
    no_index = not prompt_confirm("Create starter index.php if missing?", True)
    no_reload = not prompt_confirm("Reload nginx/PHP-FPM if running?", True)
    plan = [f"create/update app {app_name} on PHP {php}", f"main domain {domain}", f"document root: /home/{app_name}/www" + (f"/{public_dir}" if public_dir else "")]
    if aliases:
        plan.append("aliases: " + ", ".join(aliases))
    if db_name:
        plan.append(f"database: {app_name}_{db_name} on {mysql_service}")
    plan.append("reload services: " + ("no" if no_reload else "yes"))
    print_plan(plan)
    info("\nEquivalent command:")
    alias_args = " ".join(f"--alias {shlex.quote(a)}" for a in aliases)
    public_dir_arg = f" --public-dir {shlex.quote(public_dir)}" if public_dir else ""
    info(f"  ./manage.py app create {shlex.quote(app_name)} {shlex.quote(domain)}" + (f" {shlex.quote(db_name)}" if db_name else "") + f" --php {shlex.quote(php)} --mysql-service {shlex.quote(mysql_service)}" + public_dir_arg + (f" {alias_args}" if alias_args else ""))
    if prompt_confirm("Continue?", True):
        cmd_app_create(argparse.Namespace(app_name=app_name, main_domain=domain, db_suffix=db_name, php=php, mysql_service=mysql_service, alias=aliases, aliases=None, public_dir=public_dir, php_entrypoint="auto", no_index=no_index, no_reload=no_reload, uid=None, no_mysql=False, mysql_password=None))


def wizard_create_proxy() -> None:
    domain = prompt_validated("Domain", DOMAIN_RE, "domain")
    upstream = prompt_text("Upstream URL", "http://127.0.0.1:3000")
    aliases = prompt_aliases()
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([f"create/update proxy {domain}", f"upstream: {upstream}"] + (["aliases: " + ", ".join(aliases)] if aliases else []))
    if prompt_confirm("Continue?", True):
        cmd_proxy_create(argparse.Namespace(domain=domain, upstream=upstream, alias=aliases, aliases=None, no_reload=no_reload))


def wizard_tls_acme() -> None:
    db = load_db()
    domains = sorted(db.get("domains", {}).keys())
    domain = prompt_choice("Domain", domains) if domains else prompt_validated("Domain", DOMAIN_RE, "domain")
    off = not prompt_confirm("Enable ACME? (no switches back to self-signed)", True)
    no_redirect_https = False if off else not prompt_confirm("Redirect HTTP to HTTPS after ACME?", True)
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([(f"switch {domain} to self-signed" if off else f"enable ACME for {domain}"), "redirect HTTP to HTTPS: " + ("no" if no_redirect_https else "yes"), "reload nginx: " + ("no" if no_reload else "yes")])
    if prompt_confirm("Continue?", True):
        cmd_tls_acme(argparse.Namespace(domain=domain, off=off, no_redirect_https=no_redirect_https, no_reload=no_reload))


def wizard_check_permissions() -> None:
    app_name, _ = wizard_select_app()
    print_plan([f"check filesystem permissions for {app_name}"])
    info("\nEquivalent command:")
    info(f"  ./manage.py permissions check {shlex.quote(app_name)}")
    if prompt_confirm("Continue?", True):
        cmd_permissions(argparse.Namespace(permission_action="check", app_name=app_name, all=False, json=False))


def wizard_fix_permissions() -> None:
    app_name, _ = wizard_select_app()
    recursive = prompt_confirm("Repair the complete app tree recursively?", False)
    command = f"./manage.py permissions fix {shlex.quote(app_name)}" + (" --recursive" if recursive else "")
    print_plan([f"repair filesystem permissions for {app_name}", "recursive: " + ("yes" if recursive else "no")])
    info("\nEquivalent command:")
    info(f"  {command}")
    if prompt_confirm("Apply permission repair?", False):
        cmd_permissions(argparse.Namespace(permission_action="fix", app_name=app_name, all=False, recursive=recursive, dry_run=False, json=False))


def wizard_select_app(*, require_vhost: bool = False) -> tuple[str, dict[str, Any]]:
    db = load_db()
    apps = [
        (name, app)
        for name, app in sorted(db.get("apps", {}).items())
        if isinstance(app, dict) and app.get("name") and (not require_vhost or app.get("main_domain"))
    ]
    if not apps:
        die("No apps with a vhost in state. Create an app first." if require_vhost else "No apps in state. Create an app first.")
    labels = [f"{name} (main: {app.get('main_domain', '-')})" for name, app in apps]
    label = prompt_choice("App", labels)
    return apps[labels.index(label)]


def wizard_manage_domains() -> None:
    app_name, _ = wizard_select_app(require_vhost=True)
    while True:
        info(f"\nDomains for {app_name}:")
        cmd_app_domain_list(argparse.Namespace(app_name=app_name))
        db = load_db()
        app = db["apps"][app_name]
        domains = list(dict.fromkeys(app.get("domains") or [app["main_domain"]]))
        action = prompt_choice("Domain action", ["Add domain", "Delete domain", "Change main domain", "Back"])
        if action == "Back":
            return
        if action == "Add domain":
            domain = prompt_validated("Domain", DOMAIN_RE, "domain")
            no_reload = not prompt_confirm("Reload nginx if running?", True)
            print_plan([f"add {domain} to app {app_name}", "reload nginx: " + ("no" if no_reload else "yes")])
            if prompt_confirm("Continue?", True):
                cmd_app_domain_add(argparse.Namespace(app_name=app_name, domain=domain, no_reload=no_reload))
        elif action == "Delete domain":
            aliases = [domain for domain in domains if domain != app.get("main_domain")]
            if not aliases:
                warn("The main domain cannot be deleted. Add and select another domain as main first.")
                continue
            domain = prompt_choice("Domain number to delete", domains)
            if domain == app.get("main_domain"):
                warn("Cannot delete the main domain; change the main domain first.")
                continue
            no_reload = not prompt_confirm("Reload nginx if running?", True)
            print_plan([f"remove {domain} from app {app_name}", "reload nginx: " + ("no" if no_reload else "yes")])
            if prompt_confirm("Continue?", False):
                cmd_app_domain_remove(argparse.Namespace(app_name=app_name, domain=domain, no_reload=no_reload))
        else:
            domain = prompt_choice("Domain number to make main", domains, str(app.get("main_domain")))
            if domain == app.get("main_domain"):
                info(f"{domain} is already the main domain.")
                continue
            no_reload = not prompt_confirm("Reload nginx if running?", True)
            print_plan([f"set {domain} as main domain for {app_name}", "reload nginx: " + ("no" if no_reload else "yes")])
            if prompt_confirm("Continue?", True):
                cmd_app_domain_set_main(argparse.Namespace(app_name=app_name, domain=domain, no_reload=no_reload))


def wizard_manage_databases() -> None:
    app_name, app = wizard_select_app()
    while True:
        info(f"\nDatabases for {app_name}:")
        cmd_app_db_list(argparse.Namespace(app_name=app_name))
        action = prompt_choice("Database action", ["Create database", "Back"])
        if action == "Back":
            return
        suffix = prompt_validated("Database suffix", DB_NAME_RE, "database suffix")
        default_service = str(app.get("mysql_service") or default_mysql_service())
        mysql_service = prompt_validated("MySQL service", MYSQL_SERVICE_RE, "MySQL service", default_service, hint="for example mysql57, mysql84, mysql97")
        print_plan([f"create database {app_name}_{suffix}", f"MySQL service: {mysql_service}"])
        if prompt_confirm("Continue?", True):
            cmd_app_db_create(argparse.Namespace(app_name=app_name, db_suffix=suffix, mysql_service=mysql_service))
        # Return to the top of the loop so the listing immediately reflects a new DB.
        app = load_db()["apps"][app_name]


def wizard_manage_crons() -> None:
    while True:
        info("\nCron jobs:")
        cmd_cron_list(argparse.Namespace())
        db = load_db()
        crons = [(key, cron) for key, cron in sorted(db.get("crons", {}).items()) if isinstance(cron, dict)]
        actions = ["Create cron job"] + (["Delete cron job"] if crons else []) + ["Back"]
        action = prompt_choice("Cron action", actions)
        if action == "Back":
            return
        if action == "Create cron job":
            wizard_cron()
            continue
        labels = [f"{key} ({cron.get('schedule', '')}: {cron.get('command', '')})" for key, cron in crons]
        selected = prompt_choice("Cron number to delete", labels)
        cron_key, cron = crons[labels.index(selected)]
        print_plan([f"remove cron {cron_key}", f"PHP {cron.get('php_version', default_php_version())}"])
        if prompt_confirm("Continue?", False):
            cmd_cron_remove(argparse.Namespace(app_name=cron["app"], job_name=cron["job_name"]))
        # Return to the top of the loop so the listing immediately reflects removal.


def wizard_cron() -> None:
    db = load_db()
    apps = [a for a in db.get("apps", {}).values() if isinstance(a, dict) and a.get("name")]
    labels = [f"{a.get('name')} (php {a.get('php_version', default_php_version())})" for a in apps]
    label = prompt_choice("App", labels) if labels else ""
    if label:
        app = apps[labels.index(label)]
        app_name = str(app.get("name"))
        php = str(app.get("php_version") or default_php_version())
    else:
        app_name = prompt_validated("App name", APP_NAME_RE, "app_name", hint="use a Linux-safe slug like my_app or shop-api; lowercase, no spaces, max 32 chars")
        php = prompt_choice("PHP version", available_php_versions(), default_php_version())
    job_name = prompt_validated("Job name", JOB_RE, "job name")
    schedule = prompt_text("Schedule", "* * * * *")
    command = prompt_text("Command", "php artisan schedule:run")
    workdir = prompt_text("Workdir (blank = /home/<app>/www)", "", required=False) or None
    timezone = prompt_text("Timezone (blank = stack TZ)", "", required=False) or None
    output = prompt_choice("Output", ["docker", "file"], "docker")
    timeout_text = prompt_text("Timeout seconds (0 = disabled)", "0")
    try:
        timeout = int(timeout_text)
    except ValueError:
        die(f"Invalid timeout: {timeout_text}")
    lock = prompt_text("Shared lock name (blank = none)", "", required=False) or None
    print_plan([f"create/update cron {app_name}/{job_name}", f"schedule: {schedule}", f"command: {command}", f"output: {output}"])
    if prompt_confirm("Continue?", True):
        cmd_cron_create(argparse.Namespace(app_name=app_name, job_name=job_name, schedule=schedule, command=command, php=php, workdir=workdir, timezone=timezone, output=output, timeout=timeout, lock=lock))


def cmd_wizard(args: argparse.Namespace) -> None:
    if not sys.stdin.isatty():
        die("wizard requires an interactive terminal")
    actions = [
        "Create app identity",
        "Create app",
        "Create reverse proxy",
        "Enable/switch TLS ACME",
        "Manage cron jobs",
        "Manage app domains",
        "Manage app databases",
        "Check app permissions",
        "Fix app permissions",
        "Open app shell",
        "Show status",
        "List apps/domains/crons",
        "Quit",
    ]
    while True:
        info("\nVibeOps")
        action = prompt_choice("What do you want to do?", actions)
        if action == "Create app identity":
            wizard_create_user()
        elif action == "Create app":
            wizard_create_site()
        elif action == "Create reverse proxy":
            wizard_create_proxy()
        elif action == "Enable/switch TLS ACME":
            wizard_tls_acme()
        elif action == "Manage cron jobs":
            wizard_manage_crons()
        elif action == "Manage app domains":
            wizard_manage_domains()
        elif action == "Manage app databases":
            wizard_manage_databases()
        elif action == "Check app permissions":
            wizard_check_permissions()
        elif action == "Fix app permissions":
            wizard_fix_permissions()
        elif action == "Open app shell":
            cmd_app_shell(argparse.Namespace(app_name=None, php=None, workdir=None, shell="bash"))
        elif action == "Show status":
            cmd_status(argparse.Namespace(check_nginx=False))
        elif action == "List apps/domains/crons":
            kind = prompt_choice("List", ["apps", "domains", "crons", "all"], "apps")
            cmd_list(argparse.Namespace(kind=kind))
        else:
            return
        if not prompt_confirm("Back to menu?", True):
            return
