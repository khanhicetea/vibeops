"""Interactive wizard commands."""
from __future__ import annotations

import argparse
import shlex
import sys

from vibeops.helpers import *  # noqa: F403
from vibeops.app_commands import cmd_app_create, cmd_user_create
from vibeops.cron_commands import cmd_cron_create
from vibeops.proxy_commands import cmd_proxy_create
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
    print_plan([f"create/update cron {app_name}/{job_name}", f"schedule: {schedule}", f"command: {command}"])
    if prompt_confirm("Continue?", True):
        cmd_cron_create(argparse.Namespace(app_name=app_name, job_name=job_name, schedule=schedule, command=command, php=php, workdir=workdir))


def cmd_wizard(args: argparse.Namespace) -> None:
    if not sys.stdin.isatty():
        die("wizard requires an interactive terminal")
    actions = [
        "Create app identity",
        "Create app",
        "Create reverse proxy",
        "Enable/switch TLS ACME",
        "Create cron job",
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
        elif action == "Create cron job":
            wizard_cron()
        elif action == "Open app shell":
            cmd_app_shell(argparse.Namespace(app_name=None, php=default_php_version(), workdir=None, shell="bash"))
        elif action == "Show status":
            cmd_status(argparse.Namespace(check_nginx=False))
        elif action == "List apps/domains/crons":
            kind = prompt_choice("List", ["apps", "domains", "crons", "all"], "apps")
            cmd_list(argparse.Namespace(kind=kind))
        else:
            return
        if not prompt_confirm("Back to menu?", True):
            return
