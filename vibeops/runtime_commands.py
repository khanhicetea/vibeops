"""Runtime, rendering, compose, state, exec, list, and status commands."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable

from vibeops.helpers import *  # noqa: F403
from vibeops.app_commands import cmd_app_list, ensure_app, resolve_app_php_version
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
        if getattr(args, "php", None) is None:
            args.php = selected_php
    args.command = [args.shell]
    cmd_app_exec(args)


def cmd_app_exec(args: argparse.Namespace) -> None:
    app_name = validate(args.app_name, APP_NAME_RE, "app_name")
    workdir = args.workdir or f"/home/{app_name}/{DOCROOT_NAME}"
    command = args.command or ["sh"]
    if command and command[0] == "--":
        command = command[1:] or ["sh"]

    db = load_db()
    php_version = resolve_app_php_version(db, app_name, getattr(args, "php", None))
    php_cli_service = php_cli_service_for(php_version)
    identity_exists = (
        app_name in db.get("apps", {})
        and (php_version_config_dir(php_version) / "users.d" / f"{app_name}.env").exists()
    )
    ensure_app(app_name, php_version, db)
    # Only persist when ensure_app had to provision a missing identity.
    if not identity_exists:
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


def render_all_into(db: dict[str, Any], ctx: RenderContext) -> list[Path]:
    """Render a complete candidate generation into ``ctx`` (staging or live).

    Does not delete live files. Callers must promote staged output and remove
    stale managed files after a complete successful generation.
    """
    rendered: list[Path] = render_mysql_root_option_files(ctx)
    php_versions = set(available_php_versions())
    php_versions.update(
        str(app.get("php_version") or default_php_version())
        for app in db.get("apps", {}).values()
        if isinstance(app, dict)
    )
    for version in sorted(php_versions):
        rendered.append(render_php_fallback(version, ctx))
    for app_name, app in sorted(db.get("apps", {}).items()):
        if not isinstance(app, dict):
            continue
        app.setdefault("name", app_name)
        mkdir(app_home(app_name) / "logs", 0o770)
        mkdir(app_www(app_name))
        render_app_identity(app, ctx)
        if app.get("main_domain"):
            rendered.append(render_app_vhost(app, ctx))
    for domain, site in sorted(db.get("sites", {}).items()):
        if isinstance(site, dict) and site.get("type") == "proxy":
            site.setdefault("domain", domain)
            rendered.append(render_proxy_vhost(site, ctx))
    # Every shipped/configured PHP version gets a valid crontab, even with no
    # app jobs, so Supercronic always remains PID 1 and can accept SIGUSR2.
    cron_versions: set[str] = set(php_versions)
    for cron in db.get("crons", {}).values():
        if not isinstance(cron, dict):
            continue
        path = render_cron_job(cron, ctx)
        rendered.append(path)
        cron_versions.add(str(cron.get("php_version") or default_php_version()))
    for version in sorted(cron_versions):
        rendered.append(rebuild_supercronic_crontab(version, ctx))
    return rendered


def render_all(db: dict[str, Any]) -> list[Path]:
    """Stage and promote a full generation into live paths (no service reload)."""
    return apply_generated_config(db, reload_services=False, validate_services=False)


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def build_render_manifest(staging: RenderContext) -> list[dict[str, Any]]:
    """Build the managed-file manifest from a completed staging tree."""
    manifest: list[dict[str, Any]] = []
    for pattern in GENERATED_MANAGED_GLOBS:
        for path in sorted(staging.generated_dir.glob(pattern)):
            if not path.is_file() or path.name == ".gitkeep":
                continue
            if not _is_within(path, staging.generated_dir):
                die(f"Staged path escaped generated root: {path}")
            if not content_looks_generated(path) and path.name not in {".supercronic.cron", ".logrotate.conf"}:
                # Combined crontab/logrotate are generated without the notice header.
                if path.suffix == ".cron" and path.parent.name == "jobs":
                    die(f"Staged job missing generated header: {path}")
                if path.parent.name == "vhosts" or path.parent.name in {"users.d", "pool.d"}:
                    die(f"Staged config missing generated header: {path}")
            rel_path = path.relative_to(staging.generated_dir).as_posix()
            mode = 0o644
            manifest.append({
                "root": "generated",
                "rel": rel_path,
                "mode": mode,
                "sensitive": False,
            })
    if staging.secrets_dir.exists():
        for path in sorted(staging.secrets_dir.glob("*-root.cnf")):
            if not path.is_file():
                continue
            if not _is_within(path, staging.secrets_dir):
                die(f"Staged secret escaped secrets root: {path}")
            rel_path = path.relative_to(staging.secrets_dir).as_posix()
            manifest.append({
                "root": "secrets",
                "rel": rel_path,
                "mode": 0o600,
                "sensitive": True,
            })
    # Deterministic order for journal / rollback.
    manifest.sort(key=lambda e: (e["root"], e["rel"]))
    return manifest


def _live_path(entry: dict[str, Any], live: RenderContext) -> Path:
    if entry["root"] == "generated":
        return live.generated_dir / entry["rel"]
    if entry["root"] == "secrets":
        return live.secrets_dir / entry["rel"]
    die(f"Unknown manifest root: {entry.get('root')}")
    raise AssertionError("unreachable")


def _staging_path(entry: dict[str, Any], staging: RenderContext) -> Path:
    if entry["root"] == "generated":
        return staging.generated_dir / entry["rel"]
    if entry["root"] == "secrets":
        return staging.secrets_dir / entry["rel"]
    die(f"Unknown manifest root: {entry.get('root')}")
    raise AssertionError("unreachable")


def _write_journal(path: Path, journal: dict[str, Any]) -> None:
    text = json.dumps(journal, indent=2, sort_keys=True) + "\n"
    write_text_atomic(path, text, 0o600)


def _read_journal(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        die(f"Cannot read render transaction journal {rel(path)}: {exc}")
    if not isinstance(data, dict):
        die(f"Invalid render transaction journal: {rel(path)}")
    return data


def _copy_file_bytes(src: Path, dest: Path) -> None:
    mkdir(dest.parent)
    shutil.copy2(src, dest)


def _atomic_install(src: Path, dest: Path, mode: int) -> None:
    """Copy ``src`` into ``dest`` via temp + fsync + os.replace (dirs stay stable)."""
    mkdir(dest.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{dest.name}.", dir=str(dest.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(src.read_bytes())
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, dest)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def _snapshot_existing(path: Path, backup_root: Path, entry: dict[str, Any]) -> dict[str, Any]:
    record: dict[str, Any] = {
        "root": entry["root"],
        "rel": entry["rel"],
        "mode": entry["mode"],
        "existed": path.exists(),
        "created": not path.exists(),
        "backup": None,
        "previous_mode": None,
    }
    if path.exists() and path.is_file():
        backup_rel = f"{entry['root']}/{entry['rel']}"
        backup_path = backup_root / backup_rel
        _copy_file_bytes(path, backup_path)
        record["backup"] = backup_rel
        record["previous_mode"] = stat_mode(path)
    return record


def promote_manifest(
    manifest: list[dict[str, Any]],
    staging: RenderContext,
    live: RenderContext,
    backup_dir: Path,
    journal_path: Path,
    journal: dict[str, Any],
    *,
    fault_after_promotions: int | None = None,
) -> None:
    """Promote staged candidates, then remove stale managed files last."""
    journal["status"] = "promoting"
    journal["promotions"] = []
    journal["removals"] = []
    _write_journal(journal_path, journal)

    promoted = 0
    for entry in manifest:
        if fault_after_promotions is not None and promoted >= fault_after_promotions:
            raise StackError(f"Injected promotion fault after {promoted} file(s)")
        src = _staging_path(entry, staging)
        dest = _live_path(entry, live)
        if not src.is_file():
            die(f"Missing staged candidate: {src}")
        record = _snapshot_existing(dest, backup_dir, entry)
        _atomic_install(src, dest, int(entry["mode"]))
        journal["promotions"].append(record)
        _write_journal(journal_path, journal)
        promoted += 1

    # Stale removal only after every candidate exists live.
    candidate_keys = {(e["root"], e["rel"]) for e in manifest}
    for pattern in GENERATED_MANAGED_GLOBS:
        for path in sorted(live.generated_dir.glob(pattern)):
            if not path.is_file() or path.name == ".gitkeep":
                continue
            rel_path = path.relative_to(live.generated_dir).as_posix()
            key = ("generated", rel_path)
            if key in candidate_keys:
                continue
            if not content_looks_generated(path) and path.name not in {".supercronic.cron", ".logrotate.conf"}:
                warn(f"Leaving unmanaged file in place: {path}")
                continue
            entry = {"root": "generated", "rel": rel_path, "mode": 0o644}
            record = _snapshot_existing(path, backup_dir, entry)
            record["action"] = "remove"
            path.unlink()
            journal["removals"].append(record)
            _write_journal(journal_path, journal)

    if live.secrets_dir.exists():
        for path in sorted(live.secrets_dir.glob("*-root.cnf")):
            if not path.is_file():
                continue
            rel_path = path.relative_to(live.secrets_dir).as_posix()
            if ("secrets", rel_path) in candidate_keys:
                continue
            entry = {"root": "secrets", "rel": rel_path, "mode": 0o600}
            record = _snapshot_existing(path, backup_dir, entry)
            record["action"] = "remove"
            path.unlink()
            journal["removals"].append(record)
            _write_journal(journal_path, journal)

    journal["status"] = "promoted"
    _write_journal(journal_path, journal)


def rollback_from_journal(
    journal: dict[str, Any],
    live: RenderContext,
    backup_dir: Path,
) -> None:
    """Restore pre-transaction bytes/modes from journal backup (reverse order)."""
    # Undo removals first (recreate deleted files), then undo promotions reverse.
    for record in reversed(journal.get("removals") or []):
        dest = _live_path(record, live)
        backup_rel = record.get("backup")
        if backup_rel:
            src = backup_dir / backup_rel
            if src.is_file():
                mode = int(record.get("previous_mode") or record.get("mode") or 0o644)
                _atomic_install(src, dest, mode)
        elif dest.exists() and record.get("created"):
            dest.unlink(missing_ok=True)

    for record in reversed(journal.get("promotions") or []):
        dest = _live_path(record, live)
        if record.get("existed") and record.get("backup"):
            src = backup_dir / str(record["backup"])
            if src.is_file():
                mode = int(record.get("previous_mode") or record.get("mode") or 0o644)
                _atomic_install(src, dest, mode)
            continue
        # Newly created during promotion: remove.
        if dest.exists() and record.get("created"):
            dest.unlink(missing_ok=True)


def recover_abandoned_transactions(
    runtime_dir: Path,
    live: RenderContext,
    *,
    auto_restore: bool = True,
) -> None:
    """Detect leftover transaction dirs; restore mid-promotion journals safely."""
    for txn_dir in sorted(runtime_dir.glob(f"{RENDER_TXN_DIR_PREFIX}*")):
        if not txn_dir.is_dir():
            continue
        journal_path = txn_dir / "journal.json"
        if not journal_path.exists():
            # Staging-only leftover without journal: safe to drop.
            shutil.rmtree(txn_dir, ignore_errors=True)
            continue
        journal = _read_journal(journal_path)
        status = str(journal.get("status") or "")
        backup_dir = txn_dir / "backup"
        if status in {"staging", "staged"}:
            shutil.rmtree(txn_dir, ignore_errors=True)
            continue
        if status in {"promoting", "promoted", "validating"}:
            if not auto_restore:
                die(
                    f"Abandoned render transaction at vibeops/{rel(txn_dir)} "
                    f"(status={status}). Re-run ./manage.py render after recovery, "
                    f"or restore from journal backup under {rel(backup_dir)}."
                )
            # Deterministic restore when journal records promotions/removals.
            if journal.get("promotions") or journal.get("removals"):
                warn(f"Restoring previous generation from abandoned transaction {rel(txn_dir)}")
                rollback_from_journal(journal, live, backup_dir)
            shutil.rmtree(txn_dir, ignore_errors=True)
            continue
        if status in {"finalized", "complete"}:
            shutil.rmtree(txn_dir, ignore_errors=True)
            continue
        # Unknown status: do not silently delete mid-flight data.
        die(
            f"Abandoned render transaction with unknown status {status!r} at "
            f"vibeops/{rel(txn_dir)}; inspect journal.json before continuing"
        )


def validate_generated_services(db: dict[str, Any]) -> None:
    """Validate promoted config against running services. No reload signals."""
    if docker_available() and service_running("nginx"):
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])

    apps_by_version: dict[str, list[str]] = {}
    for app_name, app in db.get("apps", {}).items():
        if isinstance(app, dict):
            version = str(app.get("php_version") or default_php_version())
            apps_by_version.setdefault(version, []).append(app_name)
    for version, app_names in sorted(apps_by_version.items()):
        service = php_service_for(version)
        if service_running(service):
            run(["docker", "compose", "exec", "-T", service, "php-identity-sync", *sorted(app_names)])
            run(["docker", "compose", "exec", "-T", service, "php-fpm", "-tt"], capture=True)

    cron_versions = set(available_php_versions())
    cron_versions.update(
        str(cron.get("php_version") or default_php_version())
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict)
    )
    for version in sorted(cron_versions):
        service = php_cron_service_for(version)
        crontab = "/usr/local/etc/php/cron.d/.supercronic.cron"
        if service_running(service):
            run(["docker", "compose", "exec", "-T", service, "supercronic", "-test", crontab])
        else:
            php_service = service.removesuffix("-cron")
            if service_running(php_service):
                run(["docker", "compose", "exec", "-T", php_service, "supercronic", "-test", crontab])


def reload_generated_services(db: dict[str, Any]) -> None:
    """Signal services after successful validation. Does not roll back files on failure."""
    if service_running("nginx"):
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-s", "reload"])
        info("Reloaded nginx")
    else:
        info("nginx container is not running; start it then run: docker compose exec nginx nginx -s reload")

    apps_by_version: dict[str, list[str]] = {}
    for app_name, app in db.get("apps", {}).items():
        if isinstance(app, dict):
            version = str(app.get("php_version") or default_php_version())
            apps_by_version.setdefault(version, []).append(app_name)
    for version, app_names in sorted(apps_by_version.items()):
        service = php_service_for(version)
        if service_running(service):
            try:
                run([
                    "docker", "compose", "exec", "-T", service, "sh", "-lc",
                    "kill -USR2 1",
                ], capture=True)
                info(f"Reloaded {service}")
            except Exception as exc:
                warn(f"Failed to reload {service} after successful validation: {exc}; retry: docker compose kill -s USR2 {service}")

    cron_versions = set(available_php_versions())
    cron_versions.update(
        str(cron.get("php_version") or default_php_version())
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict)
    )
    for version in sorted(cron_versions):
        service = php_cron_service_for(version)
        if service_running(service):
            try:
                run(["docker", "compose", "kill", "-s", "USR2", service])
                info(f"Reloaded {service} cron with SIGUSR2")
            except Exception as exc:
                warn(f"Failed to reload {service} after successful validation: {exc}; retry: docker compose kill -s USR2 {service}")


def apply_generated_config(
    db: dict[str, Any],
    *,
    reload_services: bool = False,
    validate_services: bool = False,
    live: RenderContext | None = None,
    runtime_dir: Path | None = None,
    fault_after_promotions: int | None = None,
    fault_during_stage: Callable[[], None] | None = None,
) -> list[Path]:
    """Stage a full generation, promote atomically, optionally validate/reload.

    Lifecycle:
    ``state lock (caller) -> stage -> promote -> validate -> reload -> finalize``
    with rollback on stage/promote/validate failure. Reload failures after
    successful validation do not roll generated files back.
    """
    live = live or live_render_context()
    runtime_dir = runtime_dir or RUNTIME_DIR
    mkdir(runtime_dir, 0o700)
    recover_abandoned_transactions(runtime_dir, live)

    txn_id = uuid.uuid4().hex[:12]
    txn_dir = runtime_dir / f"{RENDER_TXN_DIR_PREFIX}{txn_id}"
    staging_generated = txn_dir / "staging" / "generated"
    staging_secrets = txn_dir / "staging" / "secrets" / "mysql"
    backup_dir = txn_dir / "backup"
    journal_path = txn_dir / "journal.json"
    mkdir(txn_dir, 0o700)
    mkdir(staging_generated, 0o700)
    mkdir(staging_secrets, 0o700)
    mkdir(backup_dir, 0o700)

    staging = RenderContext(generated_dir=staging_generated, secrets_dir=staging_secrets)
    journal: dict[str, Any] = {
        "version": RENDER_TXN_JOURNAL_VERSION,
        "status": "staging",
        "txn_id": txn_id,
        "promotions": [],
        "removals": [],
        "manifest": [],
    }
    _write_journal(journal_path, journal)

    live_paths: list[Path] = []
    cleanup_txn = True
    try:
        render_all_into(db, staging)
        if fault_during_stage is not None:
            fault_during_stage()
        manifest = build_render_manifest(staging)
        journal["manifest"] = manifest
        journal["status"] = "staged"
        _write_journal(journal_path, journal)

        try:
            promote_manifest(
                manifest,
                staging,
                live,
                backup_dir,
                journal_path,
                journal,
                fault_after_promotions=fault_after_promotions,
            )
        except Exception:
            rollback_from_journal(journal, live, backup_dir)
            journal["status"] = "rolled_back"
            _write_journal(journal_path, journal)
            raise

        live_paths = [_live_path(entry, live) for entry in manifest]

        if validate_services or reload_services:
            journal["status"] = "validating"
            _write_journal(journal_path, journal)
            try:
                validate_generated_services(db)
            except Exception:
                rollback_from_journal(journal, live, backup_dir)
                journal["status"] = "rolled_back"
                _write_journal(journal_path, journal)
                raise

        if reload_services:
            # Files stay at validated generation even if a reload signal fails.
            reload_generated_services(db)

        journal["status"] = "finalized"
        _write_journal(journal_path, journal)
    except Exception:
        # Leave mid-promotion journals for recovery only when rollback itself failed.
        if journal.get("status") == "promoting":
            cleanup_txn = False
        raise
    finally:
        if cleanup_txn:
            shutil.rmtree(txn_dir, ignore_errors=True)

    return live_paths


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
    rendered = apply_generated_config(db, reload_services=False, validate_services=False)
    save_db(db)
    info(f"Rendered {len(rendered)} file(s) from vibeops/{rel(DB_PATH)}")
    for path in rendered:
        info(f"  {rel(path)}")


@serialized_cron_state
def cmd_apply(args: argparse.Namespace) -> None:
    db = load_db()
    # --no-reload still validates when services are running; only skips signals.
    rendered = apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
    )
    save_db(db)
    info(f"Rendered {len(rendered)} file(s)")


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
