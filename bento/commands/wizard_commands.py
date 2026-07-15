"""Interactive wizard commands."""
from __future__ import annotations

import argparse
import re
import shlex
import sys
from typing import Any

from bento.commands.app_commands import (
    cmd_app_create,
    cmd_app_db_create,
    cmd_app_db_list,
    cmd_app_domain_add,
    cmd_app_domain_list,
    cmd_app_domain_remove,
    cmd_app_domain_set_main,
)
from bento.commands.app_config_commands import (
    cmd_app_config_customize,
    cmd_app_config_reset,
    cmd_app_config_status,
)
from bento.commands.cron_commands import cmd_cron_create, cmd_cron_list, cmd_cron_remove
from bento.commands.worker_commands import (
    cmd_worker_control,
    cmd_worker_create,
    cmd_worker_list,
    cmd_worker_remove,
)
from bento.commands.db_commands import cmd_db_backup, cmd_db_list_backups
from bento.commands.wizard_db_restore_commands import wizard_db_restore
from bento.utils.env import FPM_PROFILE_NAMES, default_fpm_profile, default_mysql_service, default_php_version
from bento.utils.errors import StackError, die, info, warn
from bento.commands.permission_commands import cmd_permissions
from bento.commands.proxy_commands import cmd_proxy_create
from bento.commands.php_version_commands import cmd_php_add, cmd_php_remove, cmd_php_versions
from bento.commands.mysql_admin_commands import wizard_manage_mysql_versions
from bento.commands.runtime_commands import (
    WizardBack,
    available_php_versions,
    cmd_app_shell,
    cmd_status,
    print_plan,
    prompt_aliases,
    prompt_choice,
    prompt_confirm,
    prompt_pick,
    prompt_public_dir,
    prompt_text,
    prompt_validated,
)
from bento.services.state import load_db
from bento.commands.tls_commands import cmd_tls_acme
from bento.ui.decorations import print_alert, print_heading
from bento.utils.validation import APP_NAME_RE, DB_NAME_RE, DOMAIN_RE, JOB_RE, MYSQL_SERVICE_RE, validate


def wizard_create_app() -> None:
    app_name = prompt_validated("App name", APP_NAME_RE, "app_name", hint="use a Linux-safe slug like my_app or shop-api; lowercase, no spaces, max 32 chars")
    domain = prompt_validated("Main domain", DOMAIN_RE, "domain")
    aliases = prompt_aliases()
    public_dir = prompt_public_dir()
    php = prompt_pick("PHP version", available_php_versions(), default_php_version())
    fpm_profile = prompt_pick(
        "PHP-FPM profile (ondemand=idle-efficient, balanced=default, throughput=higher concurrency)",
        list(FPM_PROFILE_NAMES),
        default_fpm_profile(),
    )
    db_name = prompt_validated("Database suffix, e.g. app (blank = none)", DB_NAME_RE, "database suffix", "", required=False) or None
    mysql_service = prompt_validated("MySQL service", MYSQL_SERVICE_RE, "MySQL service", default_mysql_service(), hint="for example mysql57, mysql84, mysql97") if db_name else default_mysql_service()
    no_index = not prompt_confirm("Create starter index.php if missing?", True)
    no_reload = not prompt_confirm("Reload nginx/PHP-FPM if running?", True)
    plan = [
        f"create/update app {app_name} on PHP {php}",
        f"main domain {domain}",
        f"document root: /home/{app_name}/www" + (f"/{public_dir}" if public_dir else ""),
        f"fpm profile: {fpm_profile}",
    ]
    if aliases:
        plan.append("aliases: " + ", ".join(aliases))
    if db_name:
        plan.append(f"database: {app_name}_{db_name} on {mysql_service}")
    plan.append("reload services: " + ("no" if no_reload else "yes"))
    print_plan(plan)
    info("\nEquivalent command:")
    alias_args = " ".join(f"--alias {shlex.quote(a)}" for a in aliases)
    public_dir_arg = f" --public-dir {shlex.quote(public_dir)}" if public_dir else ""
    info(
        f"  ./manage.py app create {shlex.quote(app_name)} {shlex.quote(domain)}"
        + (f" {shlex.quote(db_name)}" if db_name else "")
        + f" --php {shlex.quote(php)} --mysql-service {shlex.quote(mysql_service)}"
        + f" --fpm-profile {shlex.quote(fpm_profile)}"
        + public_dir_arg
        + (f" {alias_args}" if alias_args else "")
    )
    if prompt_confirm("Continue?", True):
        cmd_app_create(argparse.Namespace(app_name=app_name, main_domain=domain, db_suffix=db_name, php=php, mysql_service=mysql_service, alias=aliases, aliases=None, public_dir=public_dir, php_entrypoint="auto", fpm_profile=fpm_profile, access_log=None, no_index=no_index, no_reload=no_reload, uid=None, no_mysql=False, mysql_password=None))


def wizard_create_proxy() -> None:
    domain = prompt_validated("Domain", DOMAIN_RE, "domain")
    upstream = prompt_text("Upstream URL", "http://127.0.0.1:3000")
    aliases = prompt_aliases()
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([f"create/update proxy {domain}", f"upstream: {upstream}"] + (["aliases: " + ", ".join(aliases)] if aliases else []))
    if prompt_confirm("Continue?", True):
        cmd_proxy_create(argparse.Namespace(domain=domain, upstream=upstream, alias=aliases, aliases=None, no_reload=no_reload))


def wizard_tls_acme(app_name: str) -> None:
    db = load_db()
    app = db.get("apps", {}).get(app_name)
    if not isinstance(app, dict) or not app.get("main_domain"):
        die(f"App {app_name} has no domain to configure")
    domain = str(app["main_domain"])
    tls = app.get("tls")
    current_mode = tls.get("mode", "self-signed") if isinstance(tls, dict) else "self-signed"
    print_alert(f"Current TLS mode for {domain}: {current_mode}", writer=info)
    off = not prompt_confirm("Enable ACME? (no switches back to self-signed)", True)
    no_redirect_https = False if off else not prompt_confirm("Redirect HTTP to HTTPS after ACME?", True)
    no_reload = not prompt_confirm("Reload nginx if running?", True)
    print_plan([(f"switch {domain} to self-signed" if off else f"enable ACME for {domain}"), "redirect HTTP to HTTPS: " + ("no" if no_redirect_https else "yes"), "reload nginx: " + ("no" if no_reload else "yes")])
    if prompt_confirm("Continue?", True):
        cmd_tls_acme(argparse.Namespace(domain=domain, off=off, no_redirect_https=no_redirect_https, no_reload=no_reload))


def wizard_check_permissions(app_name: str | None = None) -> None:
    if app_name is None:
        app_name, _ = wizard_select_app()
    info(f"\nChecking filesystem permissions for {app_name}…")
    info(f"Equivalent command: ./manage.py permissions check {shlex.quote(app_name)}")
    try:
        cmd_permissions(argparse.Namespace(permission_action="check", app_name=app_name, all=False, json=False))
    except StackError as exc:
        print_alert(str(exc), kind="error", writer=warn)
        print_alert(
            f"Permission check failed. Suggested fix: ./manage.py permissions fix {shlex.quote(app_name)} --recursive",
            kind="warning",
            writer=warn,
        )
        if prompt_confirm("Fix permissions now?", False):
            wizard_fix_permissions(app_name)


def wizard_fix_permissions(app_name: str | None = None) -> None:
    if app_name is None:
        app_name, _ = wizard_select_app()
    recursive = prompt_confirm("Repair the complete app tree recursively?", True)
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
    label = prompt_pick("App", labels)
    return apps[labels.index(label)]


def wizard_manage_domains(app_name: str | None = None) -> None:
    if app_name is None:
        app_name, _ = wizard_select_app(require_vhost=True)
    app = load_db().get("apps", {}).get(app_name)
    if not isinstance(app, dict) or not app.get("main_domain"):
        warn(f"App {app_name} has no domain. Re-run Create app to add its vhost first.")
        return
    while True:
        print_heading(f"Domains for {app_name}", writer=info)
        cmd_app_domain_list(argparse.Namespace(app_name=app_name))
        db = load_db()
        app = db["apps"][app_name]
        domains = list(dict.fromkeys(app.get("domains") or [app["main_domain"]]))
        try:
            action = prompt_choice("Domain action", ["Add domain", "Delete domain", "Change main domain", "TLS / ACME"])
            if action == "Back":
                return
            if action == "TLS / ACME":
                wizard_tls_acme(app_name)
            elif action == "Add domain":
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
                domain = prompt_pick("Domain number to delete", domains)
                if domain == app.get("main_domain"):
                    warn("Cannot delete the main domain; change the main domain first.")
                    continue
                no_reload = not prompt_confirm("Reload nginx if running?", True)
                print_plan([f"remove {domain} from app {app_name}", "reload nginx: " + ("no" if no_reload else "yes")])
                if prompt_confirm("Continue?", False):
                    cmd_app_domain_remove(argparse.Namespace(app_name=app_name, domain=domain, no_reload=no_reload))
            else:
                domain = prompt_pick("Domain number to make main", domains, str(app.get("main_domain")))
                if domain == app.get("main_domain"):
                    info(f"{domain} is already the main domain.")
                    continue
                no_reload = not prompt_confirm("Reload nginx if running?", True)
                print_plan([f"set {domain} as main domain for {app_name}", "reload nginx: " + ("no" if no_reload else "yes")])
                if prompt_confirm("Continue?", True):
                    cmd_app_domain_set_main(argparse.Namespace(app_name=app_name, domain=domain, no_reload=no_reload))
        except WizardBack:
            continue


def wizard_manage_databases(app_name: str | None = None, app: dict[str, Any] | None = None) -> None:
    if app_name is None or app is None:
        app_name, app = wizard_select_app()
    while True:
        print_heading(f"Databases for {app_name}", writer=info)
        cmd_app_db_list(argparse.Namespace(app_name=app_name))
        try:
            action = prompt_choice(
                "Database action",
                [
                    "Create database",
                    "Backup app databases",
                    "Restore a backup",
                    "List backups",
                ],
            )
            if action == "Back":
                return
            if action == "Backup app databases":
                app_service = str(app.get("mysql_service") or default_mysql_service())
                wizard_db_backup(fixed_service=app_service, app_name=app_name)
                continue
            if action == "Restore a backup":
                app_service = str(app.get("mysql_service") or default_mysql_service())
                wizard_db_restore(fixed_service=app_service, app_name=app_name)
                continue
            if action == "List backups":
                app_service = str(app.get("mysql_service") or default_mysql_service())
                wizard_db_list_backups(fixed_service=app_service)
                continue
            suffix = prompt_validated("Database suffix", DB_NAME_RE, "database suffix")
            mysql_service = str(app.get("mysql_service") or default_mysql_service())
            print_plan([f"create database {app_name}_{suffix}", f"MySQL service: {mysql_service} (app configured service)"])
            if prompt_confirm("Continue?", True):
                cmd_app_db_create(argparse.Namespace(app_name=app_name, db_suffix=suffix, mysql_service=None))
            # Return to the top of the loop so the listing immediately reflects a new DB.
            app = load_db()["apps"][app_name]
        except WizardBack:
            continue


def wizard_mysql_service(default_service: str | None, fixed_service: str | None) -> str:
    if fixed_service:
        return validate(fixed_service, MYSQL_SERVICE_RE, "MySQL service")
    return prompt_validated(
        "MySQL service", MYSQL_SERVICE_RE, "MySQL service",
        default_service or default_mysql_service(), hint="for example mysql57, mysql84, mysql97",
    )


def wizard_db_backup(*, default_service: str | None = None, fixed_service: str | None = None,
                     app_name: str | None = None) -> None:
    """Interactive logical dump (plain .sql or zstd .sql.zst)."""
    mysql_service = wizard_mysql_service(default_service, fixed_service)
    if app_name:
        scope = "App databases"
        selected_app = app_name
        database: str | None = None
    else:
        scope = prompt_pick(
            "Backup scope",
            ["All user databases", "App databases", "Single database"],
            "All user databases",
        )
        selected_app = None
        database = None
        if scope == "App databases":
            selected_app, _ = wizard_select_app()
        elif scope == "Single database":
            database = prompt_validated(
                "Database name",
                re.compile(r"^[A-Za-z0-9_-]+$"),
                "database name",
            )

    use_zstd = prompt_confirm("Compress with zstd -3 -T1 (.sql.zst)?", True)
    keep_text = prompt_text("Keep N newest per database after success (blank = keep all)", "", required=False)
    keep: int | None = None
    if keep_text.strip():
        try:
            keep = int(keep_text.strip())
        except ValueError:
            die(f"Invalid --keep value: {keep_text}")

    plan = [f"backup on {mysql_service}", f"zstd: {'yes' if use_zstd else 'no'}"]
    if selected_app:
        plan.append(f"app databases: {selected_app}_*")
    elif database:
        plan.append(f"database: {database}")
    else:
        plan.append("all non-system databases")
    if keep is not None:
        plan.append(f"retention --keep {keep} per database")
    print_plan(plan)

    cmd_parts = ["./manage.py", "db", "backup", "--mysql-service", mysql_service]
    if selected_app:
        cmd_parts.extend(["--app", selected_app])
    elif database:
        cmd_parts.append(database)
    if use_zstd:
        cmd_parts.append("--zstd")
    if keep is not None:
        cmd_parts.extend(["--keep", str(keep)])
    info("\nEquivalent command:")
    info("  " + " ".join(shlex.quote(p) for p in cmd_parts))

    if not prompt_confirm("Continue?", True):
        return
    cmd_db_backup(
        argparse.Namespace(
            mysql_service=mysql_service,
            database=database,
            app=selected_app,
            zstd=use_zstd,
            keep=keep,
        )
    )


def wizard_db_list_backups(*, default_service: str | None = None,
                           fixed_service: str | None = None) -> None:
    mysql_service = wizard_mysql_service(default_service, fixed_service)
    print_heading(f"Backups for {mysql_service}", writer=info)
    cmd_db_list_backups(argparse.Namespace(mysql_service=mysql_service))


def wizard_manage_crons(app_name: str, app: dict[str, Any]) -> None:
    while True:
        print_heading(f"Cron jobs for {app_name}", writer=info)
        cmd_cron_list(argparse.Namespace(app_name=app_name))
        db = load_db()
        crons = [
            (key, cron) for key, cron in sorted(db.get("crons", {}).items())
            if isinstance(cron, dict) and cron.get("app") == app_name
        ]
        actions = ["Create cron job"] + (["Delete cron job"] if crons else [])
        try:
            action = prompt_choice("Cron action", actions)
            if action == "Back":
                return
            if action == "Create cron job":
                wizard_cron(app_name, app)
                continue
            labels = [f"{key} ({cron.get('schedule', '')}: {cron.get('command', '')})" for key, cron in crons]
            selected = prompt_pick("Cron number to delete", labels)
            cron_key, cron = crons[labels.index(selected)]
            print_plan([f"remove cron {cron_key}", f"PHP {cron.get('php_version', default_php_version())}"])
            if prompt_confirm("Continue?", False):
                cmd_cron_remove(argparse.Namespace(app_name=cron["app"], job_name=cron["job_name"]))
            # Return to the top of the loop so the listing immediately reflects removal.
        except WizardBack:
            continue


def wizard_cron(app_name: str, app: dict[str, Any]) -> None:
    php = str(app.get("php_version") or default_php_version())
    job_name = prompt_validated("Job name", JOB_RE, "job name")
    schedule = prompt_text("Schedule", "* * * * *")
    command = prompt_text("Command", "php artisan schedule:run")
    workdir = prompt_text("Workdir (blank = /home/<app>/www)", "", required=False) or None
    timezone = prompt_text("Timezone (blank = stack TZ)", "", required=False) or None
    output = prompt_pick("Output", ["docker", "file"], "docker")
    timeout_text = prompt_text("Timeout seconds (0 = disabled)", "0")
    try:
        timeout = int(timeout_text)
    except ValueError:
        die(f"Invalid timeout: {timeout_text}")
    lock = prompt_text("Shared lock name (blank = none)", "", required=False) or None
    print_plan([f"create/update cron {app_name}/{job_name}", f"schedule: {schedule}", f"command: {command}", f"output: {output}"])
    if prompt_confirm("Continue?", True):
        cmd_cron_create(argparse.Namespace(app_name=app_name, job_name=job_name, schedule=schedule, command=command, php=php, workdir=workdir, timezone=timezone, output=output, timeout=timeout, lock=lock))


def _app_workers(app_name: str) -> list[tuple[str, dict[str, Any]]]:
    db = load_db()
    return [
        (key, worker)
        for key, worker in sorted(db.get("workers", {}).items())
        if isinstance(worker, dict) and worker.get("app") == app_name
    ]


def wizard_manage_workers(app_name: str, app: dict[str, Any]) -> None:
    while True:
        print_heading(f"Workers for {app_name}", writer=info)
        cmd_worker_list(argparse.Namespace(app_name=app_name))
        workers = _app_workers(app_name)
        actions = ["Create worker"]
        if workers:
            actions.extend(["Delete worker", "Status", "Restart", "Stop", "Start"])
        try:
            action = prompt_choice("Worker action", actions)
            if action == "Back":
                return
            if action == "Create worker":
                wizard_worker(app_name, app)
                continue
            if action == "Status":
                labels = ["All workers for app"] + [
                    f"{key} ({' '.join(str(arg) for arg in (worker.get('command') or []))})"
                    for key, worker in workers
                ]
                selected = prompt_pick("Worker to status", labels)
                worker_name = None if selected == "All workers for app" else workers[labels.index(selected) - 1][1]["name"]
                info("\nEquivalent command:")
                cmd = f"./manage.py worker status {shlex.quote(app_name)}"
                if worker_name:
                    cmd += f" {shlex.quote(str(worker_name))}"
                info(f"  {cmd}")
                cmd_worker_control(
                    argparse.Namespace(worker_action="status", app_name=app_name, worker_name=worker_name)
                )
                continue
            labels = [
                f"{key} ({' '.join(str(arg) for arg in (worker.get('command') or []))})"
                for key, worker in workers
            ]
            selected = prompt_pick(f"Worker number to {action.split()[0].lower()}", labels)
            _key, worker = workers[labels.index(selected)]
            worker_name = str(worker["name"])
            if action == "Delete worker":
                print_plan([f"remove worker {app_name}/{worker_name}", f"PHP {worker.get('php_version', default_php_version())}"])
                info("\nEquivalent command:")
                info(f"  ./manage.py worker remove {shlex.quote(app_name)} {shlex.quote(worker_name)}")
                if prompt_confirm("Continue?", False):
                    cmd_worker_remove(argparse.Namespace(app_name=app_name, worker_name=worker_name))
                continue
            control = action.lower()
            print_plan([f"{control} worker {app_name}/{worker_name}"])
            info("\nEquivalent command:")
            info(f"  ./manage.py worker {control} {shlex.quote(app_name)} {shlex.quote(worker_name)}")
            if prompt_confirm("Continue?", True):
                cmd_worker_control(
                    argparse.Namespace(worker_action=control, app_name=app_name, worker_name=worker_name)
                )
        except WizardBack:
            continue


def wizard_worker(app_name: str, app: dict[str, Any]) -> None:
    php = str(app.get("php_version") or default_php_version())
    worker_name = prompt_validated("Worker name", JOB_RE, "worker name")
    command_text = prompt_text("Command", "php artisan queue:work --sleep=1 --tries=3")
    try:
        command = shlex.split(command_text)
    except ValueError as exc:
        die(f"Invalid command: {exc}")
    if not command:
        die("Worker command is required")
    workdir = prompt_text("Workdir (blank = /home/<app>/www)", "", required=False) or None
    stop_timeout_text = prompt_text("Stop timeout seconds", "120")
    try:
        stop_timeout = int(stop_timeout_text)
    except ValueError:
        die(f"Invalid stop timeout: {stop_timeout_text}")
    workdir_display = workdir or f"/home/{app_name}/www"
    print_plan(
        [
            f"create/update worker {app_name}/{worker_name}",
            f"PHP {php}",
            f"command: {shlex.join(command)}",
            f"workdir: {workdir_display}",
            f"stop timeout: {stop_timeout}s",
        ]
    )
    info("\nEquivalent command:")
    cmd_parts = [
        "./manage.py",
        "worker",
        "create",
        app_name,
        worker_name,
        "--php",
        php,
        "--stop-timeout",
        str(stop_timeout),
    ]
    if workdir:
        cmd_parts.extend(["--workdir", workdir])
    cmd_parts.append("--")
    cmd_parts.extend(command)
    info("  " + " ".join(shlex.quote(p) for p in cmd_parts))
    if prompt_confirm("Continue?", True):
        cmd_worker_create(
            argparse.Namespace(
                app_name=app_name,
                worker_name=worker_name,
                php=php,
                workdir=workdir,
                stop_timeout=stop_timeout,
                worker_command=["--", *command],
            )
        )


def wizard_customize_app(app_name: str) -> None:
    labels = {"Vhost": "vhost", "PHP-FPM pool": "pool"}
    while True:
        print_heading(f"Service configuration for {app_name}", writer=info)
        cmd_app_config_status(argparse.Namespace(app_name=app_name))
        try:
            action = prompt_choice("Config action", ["Customize", "Reset to generated"])
            if action == "Back":
                return
            label = prompt_pick("Service config", list(labels))
            target = labels[label]
            no_reload = not prompt_confirm("Reload the affected service if running?", True)
            if action == "Customize":
                force = False
                db = load_db()
                app = db.get("apps", {}).get(app_name, {})
                service_config = app.get("service_config", {}) if isinstance(app, dict) else {}
                record = service_config.get(target, {}) if isinstance(service_config, dict) else {}
                if isinstance(record, dict) and record.get("mode") == "custom":
                    force = prompt_confirm("Replace the custom source with the current upstream template?", False)
                info("\nEquivalent command:")
                command = f"./manage.py app config customize {shlex.quote(app_name)} {target}"
                if force:
                    command += " --force"
                if no_reload:
                    command += " --no-reload"
                info(f"  {command}")
                if prompt_confirm("Activate customization?", True):
                    cmd_app_config_customize(argparse.Namespace(app_name=app_name, target=target, force=force, no_edit=False, no_reload=no_reload))
            else:
                info("\nEquivalent command:")
                command = f"./manage.py app config reset {shlex.quote(app_name)} {target}"
                if no_reload:
                    command += " --no-reload"
                info(f"  {command}")
                if prompt_confirm("Reset to the generated template?", False):
                    cmd_app_config_reset(argparse.Namespace(app_name=app_name, target=target, no_reload=no_reload))
        except WizardBack:
            continue


def wizard_manage_app() -> None:
    app_name, app = wizard_select_app()
    actions = ["Shell", "Databases", "Cronjobs", "Workers", "Domains", "Audit File Permissions", "Customize"]
    while True:
        app = load_db().get("apps", {}).get(app_name, app)
        print_heading(f"Manage app: {app_name} (main: {app.get('main_domain', '-')})", writer=info)
        try:
            action = prompt_choice("App action", actions)
            if action == "Back":
                return
            if action == "Shell":
                cmd_app_shell(argparse.Namespace(app_name=app_name, php=None, workdir=None, shell="bash"))
            elif action == "Databases":
                wizard_manage_databases(app_name, app)
            elif action == "Cronjobs":
                wizard_manage_crons(app_name, app)
            elif action == "Workers":
                wizard_manage_workers(app_name, app)
            elif action == "Domains":
                wizard_manage_domains(app_name)
            elif action == "Audit File Permissions":
                wizard_check_permissions(app_name)
            else:
                wizard_customize_app(app_name)
        except WizardBack:
            continue


def wizard_manage_php_versions() -> None:
    while True:
        print_heading("Managed PHP versions", writer=info)
        cmd_php_versions(argparse.Namespace())
        action = prompt_choice("PHP version action", ["Add version", "Remove version"])
        if action == "Back":
            return
        if action == "Add version":
            version = prompt_validated("PHP version", re.compile(r"^[0-9]+\.[0-9]+$"), "PHP version", "8.5")
            print_plan([f"add PHP {version}", "generate compose.d/bento-php-versions.yml"])
            if prompt_confirm("Continue?", True):
                cmd_php_add(argparse.Namespace(version=version))
        else:
            versions = available_php_versions()
            version = prompt_pick("PHP version to remove", versions)
            print_plan([f"remove PHP {version}", "only allowed when no app uses it"])
            if prompt_confirm("Continue?", False):
                cmd_php_remove(argparse.Namespace(version=version))


def cmd_wizard(args: argparse.Namespace) -> None:
    if not sys.stdin.isatty():
        die("wizard requires an interactive terminal")
    actions = ["Create app", "Manage app", "Manage PHP versions", "Manage MySQL versions", "Show services status"]
    while True:
        print_heading("bento", writer=info)
        action = prompt_choice("What do you want to do?", actions, zero="Quit")
        if action == "Quit":
            return
        try:
            if action == "Create app":
                wizard_create_app()
            elif action == "Manage app":
                wizard_manage_app()
            elif action == "Manage PHP versions":
                wizard_manage_php_versions()
            elif action == "Manage MySQL versions":
                wizard_manage_mysql_versions()
            else:
                cmd_status(argparse.Namespace(check_nginx=False))
        except WizardBack:
            continue
