"""Runtime, rendering, compose, state, exec, list, and status commands."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from vibeops.helpers import *  # noqa: F403
from vibeops.app_commands import cmd_app_list, ensure_app
from vibeops.cron_commands import render_cron_job
from vibeops.proxy_commands import render_proxy_vhost

def select_app_from_db() -> tuple[str, str]:
    db = load_db()
    apps = [app for app in db.get("apps", {}).values() if isinstance(app, dict) and app.get("name")]
    apps.sort(key=lambda a: str(a.get("name")))
    if not apps:
        die("No apps in state. Create one with: ./manage.py app create <app_name> <main_domain>")
    if len(apps) == 1:
        app = apps[0]
        return str(app["name"]), str(app.get("php_version") or default_php_version())
    if not sys.stdin.isatty():
        choices = ", ".join(str(app.get("name")) for app in apps)
        die(f"Multiple apps found in state; choose one explicitly. Apps: {choices}")
    info("Select app:")
    for idx, app in enumerate(apps, start=1):
        info(f"  {idx}) {app.get('name')}  main={app.get('main_domain', '-')}  php={app.get('php_version', default_php_version())}")
    while True:
        raw = input("App number: ").strip()
        try:
            choice = int(raw)
        except ValueError:
            choice = 0
        if 1 <= choice <= len(apps):
            app = apps[choice - 1]
            return str(app["name"]), str(app.get("php_version") or default_php_version())
        warn("invalid selection")


def cmd_app_shell(args: argparse.Namespace) -> None:
    if not args.app_name:
        args.app_name, selected_php = select_app_from_db()
        if args.php == default_php_version():
            args.php = selected_php
    args.command = [args.shell]
    cmd_app_exec(args)


def cmd_app_exec(args: argparse.Namespace) -> None:
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    php_version = validate(args.php, PHP_VERSION_RE, "PHP version")
    php_cli_service = php_cli_service_for(php_version)
    workdir = args.workdir or f"/home/{app_name}/{DOCROOT_NAME}"
    command = args.command or ["sh"]
    if command and command[0] == "--":
        command = command[1:] or ["sh"]

    db = load_db()
    ensure_app(app_name, php_version, db)
    save_db(db)

    if not docker_available():
        die("docker is required")
    tty_args: list[str] = []
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        tty_args.append("-T")
    os.execvp("docker", [
        "docker", "compose", "run", "--rm", *tty_args,
        php_cli_service,
        app_name, workdir,
        *command,
    ])


def cmd_list(args: argparse.Namespace) -> None:
    db = load_db()
    kind = args.kind
    if kind == "apps":
        cmd_app_list(args)
    elif kind == "domains":
        domains = db.get("domains", {})
        if not domains:
            info("No domains in state.")
            return
        for domain, owner in sorted(domains.items()):
            if owner.get("kind") == "php":
                info(f"{domain}\tphp\tapp={owner.get('app', '')}")
            else:
                info(f"{domain}\tproxy\tvhost={owner.get('domain', '')}")
    elif kind in {"users", "sites"}:
        warn(f"'list {kind}' is deprecated; use 'list apps' or 'list domains'")
        cmd_list(argparse.Namespace(kind="apps" if kind == "users" else "domains"))
    elif kind == "crons":
        crons = db.get("crons", {})
        if not crons:
            info("No crons in state. Create one with: ./manage.py cron create <app_name> <name> '<schedule>' '<command>'")
            return
        for key, cron in sorted(crons.items()):
            if not isinstance(cron, dict):
                continue
            info(f"{key}\t{cron.get('schedule', '')}\t{cron.get('command', '')}")
    else:
        print(json.dumps(db, indent=2, sort_keys=True))


def clean_generated_config() -> None:
    patterns = [
        "nginx/vhosts/*.conf",
        "php/versions/*/users.d/*.env",
        "php/versions/*/pool.d/*.conf",
        "cron/php*/jobs/*.cron",
        "cron/php*/.supercronic.cron",
    ]
    for pattern in patterns:
        for path in GENERATED_DIR.glob(pattern):
            if path.name != ".gitkeep":
                path.unlink(missing_ok=True)


def render_all(db: dict[str, Any]) -> list[Path]:
    clean_generated_config()
    rendered: list[Path] = []
    php_versions = set(available_php_versions())
    php_versions.update(str(app.get("php_version") or default_php_version()) for app in db.get("apps", {}).values() if isinstance(app, dict))
    for version in sorted(php_versions):
        rendered.append(render_php_fallback(version))
    for app_name, app in sorted(db.get("apps", {}).items()):
        if not isinstance(app, dict):
            continue
        app.setdefault("name", app_name)
        mkdir(app_home(app_name) / "logs", 0o770)
        mkdir(app_www(app_name))
        render_app_identity(app)
        if app.get("main_domain"):
            rendered.append(render_app_vhost(app))
    for domain, site in sorted(db.get("sites", {}).items()):
        if isinstance(site, dict) and site.get("type") == "proxy":
            site.setdefault("domain", domain)
            rendered.append(render_proxy_vhost(site))
    # Every shipped/configured PHP version gets a valid crontab, even with no
    # app jobs, so Supercronic always remains PID 1 and can accept SIGUSR2.
    cron_versions: set[str] = set(php_versions)
    for cron in db.get("crons", {}).values():
        if not isinstance(cron, dict):
            continue
        path = render_cron_job(cron)
        rendered.append(path)
        cron_versions.add(str(cron.get("php_version") or default_php_version()))
    for version in sorted(cron_versions):
        rendered.append(rebuild_supercronic_crontab(version))
    return rendered


def compose_files() -> list[Path]:
    files = [ROOT / "compose.yml"]
    for path in [ROOT / "compose.override.yml", ROOT / "compose.local.yml"]:
        if path.exists():
            files.append(path)
    compose_d = ROOT / "compose.d"
    if compose_d.exists():
        files.extend(sorted(compose_d.glob("*.yml")))
        files.extend(sorted(compose_d.glob("*.yaml")))
    return files


def cmd_compose(args: argparse.Namespace) -> None:
    files = compose_files()
    cmd = ["docker", "compose"]
    for path in files:
        cmd.extend(["-f", str(path)])
    cmd.extend(args.compose_args or ["ps"])
    os.execvp("docker", cmd)


@serialized_cron_state
def cmd_render(args: argparse.Namespace) -> None:
    db = load_db()
    rendered = render_all(db)
    save_db(db)
    info(f"Rendered {len(rendered)} file(s) from vibeops/{rel(DB_PATH)}")
    for path in rendered:
        info(f"  {rel(path)}")


@serialized_cron_state
def cmd_apply(args: argparse.Namespace) -> None:
    db = load_db()
    rendered = render_all(db)
    save_db(db)
    info(f"Rendered {len(rendered)} file(s)")
    if args.no_reload:
        return
    if docker_available() and service_running("nginx"):
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])
    nginx_reload(False)
    apps_by_version: dict[str, list[str]] = {}
    for app_name, app in db.get("apps", {}).items():
        if isinstance(app, dict):
            version = str(app.get("php_version") or default_php_version())
            apps_by_version.setdefault(version, []).append(app_name)
    for version, app_names in sorted(apps_by_version.items()):
        service = php_service_for(version)
        if service_running(service):
            run(["docker", "compose", "exec", "-T", service, "php-identity-sync", *sorted(app_names)])
            run(["docker", "compose", "exec", "-T", service, "php-fpm", "-tt"])
            run(["docker", "compose", "kill", "-s", "USR2", service])
    cron_versions = set(available_php_versions())
    cron_versions.update(str(cron.get("php_version") or default_php_version()) for cron in db.get("crons", {}).values() if isinstance(cron, dict))
    for version in sorted(cron_versions):
        cron_reload(php_cron_service_for(version))


def cmd_state(args: argparse.Namespace) -> None:
    if args.state_action == "path":
        info(str(DB_PATH))
    elif args.state_action == "show":
        print(json.dumps(load_db(), indent=2, sort_keys=True))
    elif args.state_action == "migrate":
        if DB_PATH.exists() and not args.force:
            die(f"{rel(DB_PATH)} already exists; use --force to overwrite")
        data = load_db()
        save_db(data)
        if LEGACY_DB_PATH.exists() and LEGACY_DB_PATH != DB_PATH:
            backup = LEGACY_DB_PATH.with_suffix(".json.legacy")
            if not backup.exists():
                LEGACY_DB_PATH.rename(backup)
                info(f"Moved legacy state to vibeops/{rel(backup)}")
            else:
                warn(f"legacy state remains at {rel(LEGACY_DB_PATH)} because {rel(backup)} already exists")
        info(f"Migrated state to vibeops/{rel(DB_PATH)}")
    elif args.state_action == "init":
        if DB_PATH.exists() and not args.force:
            die(f"{rel(DB_PATH)} already exists; use --force to overwrite")
        save_db(empty_db())
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


def prompt_validated(label: str, pattern: re.Pattern[str], value_label: str, default: str | None = None, *, required: bool = True, hint: str | None = None) -> str:
    while True:
        value = prompt_text(label, default, required=required)
        if not value and not required:
            return value
        if pattern.match(value):
            return value
        warn(f"invalid {value_label}: {value}" + (f" ({hint})" if hint else ""))


def prompt_int(label: str, default: str | None = None, *, required: bool = False) -> int | None:
    while True:
        value = prompt_text(label, default, required=required)
        if not value:
            return None
        try:
            return int(value)
        except ValueError:
            warn(f"invalid integer: {value}")


def prompt_public_dir() -> str:
    while True:
        raw = prompt_text("Public dir inside www (blank = www, Laravel: public)", "", required=False)
        try:
            return validate_public_dir(raw)
        except StackError as exc:
            warn(str(exc))


def prompt_aliases() -> list[str]:
    while True:
        raw = prompt_text("Aliases, comma-separated (blank = none)", "", required=False)
        aliases = parse_csv(raw)
        invalid = [a for a in aliases if not DOMAIN_RE.match(a)]
        if not invalid:
            return aliases
        warn("invalid alias domain(s): " + ", ".join(invalid))


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
    version_set: set[str] = set()
    for base in (LEGACY_PHP_VERSIONS_DIR, PHP_VERSIONS_DIR):
        if base.exists():
            version_set.update(p.name for p in base.iterdir() if p.is_dir())
    versions = sorted(version_set)
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
    info("\nApps:")
    apps = db.get("apps", {})
    if not apps:
        info("  none")
    for name, app in sorted(apps.items()):
        if not isinstance(app, dict):
            continue
        tls = app.get("tls", {}).get("mode", "")
        info(f"  {name:<20} php={app.get('php_version', ''):<4} entrypoint={app.get('php_entrypoint', ''):<16} main={app.get('main_domain', '-')} tls={tls}")
    proxies = [s for s in db.get("sites", {}).values() if isinstance(s, dict) and s.get("type") == "proxy"]
    if proxies:
        info("\nProxies:")
        for site in sorted(proxies, key=lambda s: str(s.get("domain"))):
            info(f"  {site.get('domain', ''):<28} {site.get('upstream', '')} tls={site.get('tls', {}).get('mode', '')}")
    info("\nQuick checks:")
    info(f"  metadata: vibeops/{rel(DB_PATH)} {'exists' if DB_PATH.exists() else 'missing'}")
    info(f"  vhosts:   vibeops/{rel(NGINX_VHOST_DIR)}")
    for mysql_service in ("mysql57", "mysql84", "mysql97"):
        if mysql_service in running:
            ok = mysql_admin_ping(mysql_service)
            info(f"  {mysql_service} ping: {'ok' if ok else 'failed'}")
            info(f"  {mysql_service} logs: vibeops/{rel(mysql_log_dir(mysql_service))}")
    if args.check_nginx and "nginx" in running:
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])
