"""Runtime, rendering, compose, state, exec, list, and status commands."""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Collection

from bento.commands.app_commands import cmd_app_list, ensure_app, resolve_app_php_version
from bento.commands.cron_commands import render_cron_job
from bento.services.compose import compose_command, compose_prefix
from bento.services.cron_runtime import rebuild_supercronic_crontab
from bento.services.runner import reconcile_runner, render_runner_programs, runner_versions, validate_runner
from bento.utils.env import default_php_version, fpm_capacity_warnings, php_fpm_process_max
from bento.utils.errors import StackError, die, info, warn
from bento.os.fsutil import mkdir, write_text_atomic
from bento.services.mysql import mysql_admin_ping, mysql_log_dir, render_mysql_root_option_files
from bento.services.nginx import render_app_vhost
from bento.utils.paths import (
    DB_PATH, DOCROOT_NAME, GENERATED_MANAGED_GLOBS, NGINX_VHOST_DIR,
    PHP_VERSIONS_DIR, RENDER_TXN_DIR_PREFIX, RENDER_TXN_JOURNAL_VERSION, ROOT,
    RUNTIME_DIR, RenderContext, live_render_context, rel
)
from bento.services.php import (
    app_home, app_www, php_cli_service_for,
    php_service_for, php_version_config_dir, render_app_identity, render_php_fallback
)
from bento.services.php_versions import render_php_versions_compose
from bento.os.process import docker_available, run, running_services, service_running
from bento.commands.proxy_commands import render_proxy_vhost
from bento.services.rendering import content_looks_generated
from bento.services.state import empty_db, load_db, save_db, serialized_cron_state
from bento.ui.decorations import format_bottom_border, format_menu, left_pad, print_heading, print_list
from bento.ui.table import print_ascii_table as print_table
from bento.utils.validation import APP_NAME_RE, DOMAIN_RE, validate, validate_public_dir

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
    labels = [
        f"{app.get('name')}  main={app.get('main_domain', '-')}  php={app.get('php_version', default_php_version())}"
        for app in apps
    ]
    try:
        label = prompt_pick("Select app", labels)
    except WizardBack:
        die("Cancelled")
    app = apps[labels.index(label)]
    return str(app["name"]), str(app.get("php_version") or default_php_version())

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
    # The Compose topology is disposable state-derived output. Refresh it here
    # so shell/exec cannot fail because a checkout has a missing or stale CLI role.
    render_php_versions_compose(db)
    tty_args: list[str] = []
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        tty_args.append("-T")
    os.execvp("docker", compose_command(
        "run", "--rm", *tty_args,
        php_cli_service,
        app_name, workdir,
        *command,
    ))

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
        rows = []
        for domain, owner in sorted(domains.items()):
            if not isinstance(owner, dict):
                continue
            if owner.get("kind") == "php":
                rows.append([domain, "php", f"app={owner.get('app', '')}"])
            else:
                rows.append([domain, "proxy", f"vhost={owner.get('domain', '')}"])
        print_table(rows, headers=["DOMAIN", "KIND", "OWNER"])
    elif kind == "crons":
        crons = db.get("crons", {})
        if not crons:
            info("No crons in state. Create one with: ./manage.py cron create <app_name> <name> '<schedule>' '<command>'")
            return
        rows = []
        for key, cron in sorted(crons.items()):
            if not isinstance(cron, dict):
                continue
            rows.append([key, str(cron.get("schedule", "") or ""), str(cron.get("command", "") or "")])
        print_table(rows, headers=["JOB", "SCHEDULE", "COMMAND"])
    elif kind == "workers":
        from bento.commands.worker_commands import cmd_worker_list

        cmd_worker_list(argparse.Namespace(app_name=None))
    else:
        print(json.dumps(db, indent=2, sort_keys=True))

def render_all_into(db: dict[str, Any], ctx: RenderContext) -> list[Path]:
    """Render a complete candidate generation into ``ctx`` (staging or live).

    Does not delete live files. Callers must promote staged output and remove
    stale managed files after a complete successful generation.
    """
    rendered: list[Path] = render_mysql_root_option_files(ctx, db)
    php_versions = set(available_php_versions())
    php_versions.update(
        str(app.get("php_version") or default_php_version())
        for app in db.get("apps", {}).values()
        if isinstance(app, dict)
    )
    php_versions.update(
        str(cron.get("php_version") or default_php_version())
        for cron in db.get("crons", {}).values()
        if isinstance(cron, dict)
    )
    php_versions.update(
        str(worker.get("php_version") or default_php_version())
        for worker in db.get("workers", {}).values()
        if isinstance(worker, dict)
    )
    for version in sorted(php_versions):
        rendered.append(render_php_fallback(version, ctx))
    for app_name, app in sorted(db.get("apps", {}).items()):
        if not isinstance(app, dict):
            continue
        app.setdefault("name", app_name)
        mkdir(app_home(app_name) / "logs", 0o700)
        mkdir(app_www(app_name))
        render_app_identity(app, ctx)
        if app.get("main_domain"):
            rendered.append(render_app_vhost(app, ctx))
    for domain, site in sorted(db.get("sites", {}).items()):
        if isinstance(site, dict) and site.get("type") == "proxy":
            site.setdefault("domain", domain)
            rendered.append(render_proxy_vhost(site, ctx))
    # Render job snippets, then one app-owned Supercronic crontab per app.
    for cron in db.get("crons", {}).values():
        if not isinstance(cron, dict):
            continue
        rendered.append(render_cron_job(cron, ctx))
    for version in sorted(php_versions):
        rendered.append(rebuild_supercronic_crontab(version, ctx))
        rendered.append(render_runner_programs(db, version, ctx))
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
            if not content_looks_generated(path):
                die(f"Staged managed file missing generated header: {path}")
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
            if not content_looks_generated(path) and path.name != ".supercronic.cron":
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
                    f"Abandoned render transaction at bento/{rel(txn_dir)} "
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
            f"bento/{rel(txn_dir)}; inspect journal.json before continuing"
        )

# Logical service groups that can be selectively validated/reloaded after a
# full generation. Domain/proxy/TLS changes only need nginx; identity/pool
# changes need php; cron/worker changes need runner. Full apply uses all three.
SERVICE_TARGETS_ALL = frozenset({"nginx", "php", "runner"})
SERVICE_TARGETS_NGINX = frozenset({"nginx"})


def normalize_service_targets(targets: Collection[str] | None) -> frozenset[str]:
    """Return a validated frozenset of service targets (default: all)."""
    if targets is None:
        return SERVICE_TARGETS_ALL
    allowed = SERVICE_TARGETS_ALL
    resolved = frozenset(targets)
    unknown = resolved - allowed
    if unknown:
        die(f"Unknown service target(s): {', '.join(sorted(unknown))}; expected one of {', '.join(sorted(allowed))}")
    if not resolved:
        die("service_targets must not be empty")
    return resolved


def validate_generated_services(db: dict[str, Any], *, services: Collection[str] | None = None) -> None:
    """Validate promoted config against running services. No reload signals."""
    want = normalize_service_targets(services)

    if "nginx" in want and docker_available() and service_running("nginx"):
        run([*compose_prefix(), "exec", "-T", "nginx", "nginx", "-t"])

    if "php" in want:
        apps_by_version: dict[str, list[str]] = {}
        for app_name, app in db.get("apps", {}).items():
            if isinstance(app, dict):
                version = str(app.get("php_version") or default_php_version())
                apps_by_version.setdefault(version, []).append(app_name)
        for version, app_names in sorted(apps_by_version.items()):
            service = php_service_for(version)
            if service_running(service):
                run([*compose_prefix(), "exec", "-T", service, "php-identity-sync", *sorted(app_names)])
                run([*compose_prefix(), "exec", "-T", service, "php-fpm", "-tt"], capture=True)

    if "runner" in want:
        for version in sorted(runner_versions(db, available_php_versions())):
            validate_runner(db, version)


def reload_generated_services(db: dict[str, Any], *, services: Collection[str] | None = None) -> None:
    """Signal services after successful validation. Does not roll back files on failure."""
    want = normalize_service_targets(services)

    if "nginx" in want:
        if service_running("nginx"):
            run([*compose_prefix(), "exec", "-T", "nginx", "nginx", "-s", "reload"])
            info("Reloaded nginx")
        else:
            info("nginx container is not running; start it then run: ./dc exec nginx nginx -s reload")

    if "php" in want:
        apps_by_version: dict[str, list[str]] = {}
        for app_name, app in db.get("apps", {}).items():
            if isinstance(app, dict):
                version = str(app.get("php_version") or default_php_version())
                apps_by_version.setdefault(version, []).append(app_name)
        for version, app_names in sorted(apps_by_version.items()):
            service = php_service_for(version)
            if service_running(service):
                try:
                    run([*compose_prefix(),
                         "exec", "-T", service, "sh", "-lc",
                        "kill -USR2 1",
                    ], capture=True)
                    info(f"Reloaded {service}")
                except Exception as exc:
                    warn(f"Failed to reload {service} after successful validation: {exc}; retry: ./dc kill -s USR2 {service}")

    if "runner" in want:
        for version in sorted(runner_versions(db, available_php_versions())):
            try:
                reconcile_runner(db, version)
            except Exception as exc:
                warn(f"Failed to reconcile PHP {version} runner after successful validation: {exc}")


def apply_generated_config(
    db: dict[str, Any],
    *,
    reload_services: bool = False,
    validate_services: bool = False,
    service_targets: Collection[str] | None = None,
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

    ``service_targets`` limits which service groups are validated/reloaded
    (``nginx``, ``php``, ``runner``). Default is all three. Nginx-only mutations
    (domains, proxy, TLS) should pass ``SERVICE_TARGETS_NGINX``.
    """
    targets = normalize_service_targets(service_targets)
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
                validate_generated_services(db, services=targets)
            except Exception:
                rollback_from_journal(journal, live, backup_dir)
                journal["status"] = "rolled_back"
                _write_journal(journal_path, journal)
                raise

        if reload_services:
            # Files stay at validated generation even if a reload signal fails.
            reload_generated_services(db, services=targets)

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

def cmd_compose(args: argparse.Namespace) -> None:
    compose_args = args.compose_args or ["ps"]
    # A typo here can erase every durable database volume. Bento deliberately
    # provides no bypass; use raw docker compose only for an intentional wipe.
    if "down" in compose_args and any(arg in {"-v", "--volumes"} or (arg.startswith("-") and not arg.startswith("--") and "v" in arg[1:]) for arg in compose_args):
        die("Refusing 'compose down -v/--volumes': it can permanently delete MySQL data volumes")
    cmd = [*compose_prefix(), *compose_args]
    os.execvp("docker", cmd)

@serialized_cron_state
def cmd_render(args: argparse.Namespace) -> None:
    db = load_db()
    rendered = apply_generated_config(db, reload_services=False, validate_services=False)
    from bento.services.php_versions import render_php_versions_compose
    from bento.services.mysql_versions import render_mysql_versions_compose
    render_php_versions_compose(db)
    render_mysql_versions_compose(db)
    save_db(db)
    info(f"Rendered {len(rendered)} file(s) from bento/{rel(DB_PATH)}")
    for path in rendered:
        info(f"  {rel(path)}")

@serialized_cron_state
def cmd_apply(args: argparse.Namespace) -> None:
    db = load_db()
    from bento.services.php_versions import render_php_versions_compose
    from bento.services.mysql_versions import render_mysql_versions_compose
    render_php_versions_compose(db)
    render_mysql_versions_compose(db)
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
    elif args.state_action == "init":
        if DB_PATH.exists() and not args.force:
            die(f"{rel(DB_PATH)} already exists; use --force to overwrite")
        save_db(empty_db())
        info(f"Initialized bento/{rel(DB_PATH)}")

def prompt_text(label: str, default: str | None = None, *, required: bool = True) -> str:
    suffix = f" [{default}]" if default not in (None, "") else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if not value and default is not None:
            value = default
        if value or not required:
            return value
        warn("required")


def prompt_password(label: str = "MySQL password (blank = generate)") -> str | None:
    """Read a secret without echoing (uses getpass). Blank input means generate/omit.

    KeyboardInterrupt and EOFError propagate so ``cli.main`` can exit cleanly.
    """
    value = getpass.getpass(f"{label}: ")
    return value or None

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

class WizardBack(Exception):
    """User selected 0 (Back) in a numbered choice prompt."""


def _choice_entries(
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> list[tuple[str, int, str]]:
    """Build (return_value, number, label) rows for a choice menu."""
    entries: list[tuple[str, int, str]] = []
    if zero is not None:
        entries.append((zero, 0, zero))
    for idx, choice in enumerate(choices, start=1):
        marker = " *" if choice == default else ""
        entries.append((choice, idx, f"{choice}{marker}"))
    return entries


def _resolve_choice_number(
    idx: int,
    choices: list[str],
    zero: str | None,
) -> str | None:
    if zero is not None and idx == 0:
        return zero
    if 1 <= idx <= len(choices):
        return choices[idx - 1]
    return None


def _prompt_choice_numbered(
    label: str,
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> str:
    """Line-oriented number prompt (pipes, tests, non-TTY)."""
    entries = _choice_entries(choices, default, zero)
    for line in format_menu(label, [(num, text) for _value, num, text in entries]):
        info(line)
    lo = 0 if zero is not None else 1
    while True:
        raw = input(
            f"Choose {lo}-{len(choices)}"
            + (f" [{default}]" if default else "")
            + ": "
        ).strip()
        if not raw and default:
            return default
        try:
            idx = int(raw)
        except ValueError:
            idx = -1
        resolved = _resolve_choice_number(idx, choices, zero)
        if resolved is not None:
            return resolved
        warn("invalid selection")


def _is_csi_final(ch: str) -> bool:
    """True for a CSI final byte (0x40–0x7E, i.e. '@' through '~')."""
    return len(ch) == 1 and "@" <= ch <= "~"


def _read_menu_key() -> str:
    """Read one key from stdin in cbreak mode. Returns 'up'/'down'/'enter'/'backspace'/digit/ctrl chars."""
    ch = sys.stdin.read(1)
    if not ch:
        raise EOFError
    if ch == "\x1b":
        # ANSI escape: arrows are ESC [ A/B/C/D (and ESC O A/B on some terminals).
        rest = sys.stdin.read(1)
        if rest == "[":
            code = sys.stdin.read(1)
            if code == "A":
                return "up"
            if code == "B":
                return "down"
            if code in ("C", "D"):
                # Left/right: ignore (do not hang waiting for more CSI bytes).
                return "esc"
            # Consume remaining intermediate CSI params until a final byte (0x40–0x7E).
            # Note: use a range check, not `in "@-~"` (that is only three characters).
            while code and not _is_csi_final(code):
                code = sys.stdin.read(1)
            return "esc"
        if rest == "O":
            code = sys.stdin.read(1)
            if code == "A":
                return "up"
            if code == "B":
                return "down"
            return "esc"
        return "esc"
    if ch in ("\r", "\n"):
        return "enter"
    if ch in ("\x7f", "\b"):
        return "backspace"
    if ch == "\x03":
        raise KeyboardInterrupt
    if ch == "\x04":
        raise EOFError
    return ch


def _prompt_choice_interactive(
    label: str,
    choices: list[str],
    default: str | None,
    zero: str | None,
) -> str:
    """TTY menu: ↑/↓ + Enter to select; digits still work as a number fallback."""
    import termios
    import tty

    entries = _choice_entries(choices, default, zero)
    lo = 0 if zero is not None else 1
    hi = len(choices)
    # Highlight default choice when present; otherwise first real option (or 0 if only zero).
    selected = 0
    if default is not None:
        for i, (value, _num, _text) in enumerate(entries):
            if value == default:
                selected = i
                break
    elif zero is not None and len(entries) > 1:
        selected = 1
    digit_buf = ""
    instant_digits = hi <= 9
    hint = f"↑↓ move · Enter select · or type {lo}-{hi}"
    if instant_digits:
        hint += " (digit selects)"
    body_lines = 1 + len(entries) + 2  # label + options + hint + bottom border
    first_draw = True

    def draw() -> None:
        nonlocal first_draw
        lines = format_menu(
            label,
            [(num, text) for _value, num, text in entries],
            selected_number=entries[selected][1],
            bottom_border=False,
        )
        status = hint
        if digit_buf:
            status = f"number: {digit_buf}_  · Enter confirm · Backspace edit"
        lines.append(left_pad(status))
        lines.append(format_bottom_border())
        if not first_draw:
            sys.stdout.write(f"\033[{body_lines}A")
        for line in lines:
            sys.stdout.write(f"\033[2K\r{line}\n")
        sys.stdout.flush()
        first_draw = False

    fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(fd)
    # Hide cursor while the menu is active.
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()
    try:
        tty.setcbreak(fd)
        draw()
        while True:
            key = _read_menu_key()
            if key == "up":
                digit_buf = ""
                selected = (selected - 1) % len(entries)
                draw()
            elif key == "down":
                digit_buf = ""
                selected = (selected + 1) % len(entries)
                draw()
            elif key == "enter":
                if digit_buf:
                    try:
                        idx = int(digit_buf)
                    except ValueError:
                        idx = -1
                    resolved = _resolve_choice_number(idx, choices, zero)
                    if resolved is not None:
                        return resolved
                    digit_buf = ""
                    draw()
                    continue
                return entries[selected][0]
            elif key == "backspace":
                if digit_buf:
                    digit_buf = digit_buf[:-1]
                    draw()
            elif key.isdigit():
                if instant_digits:
                    resolved = _resolve_choice_number(int(key), choices, zero)
                    if resolved is not None:
                        return resolved
                    continue
                digit_buf += key
                # Snap highlight when the buffer is a complete valid number.
                try:
                    idx = int(digit_buf)
                except ValueError:
                    idx = -1
                for i, (_value, num, _text) in enumerate(entries):
                    if num == idx:
                        selected = i
                        break
                draw()
            # Ignore other keys (letters, esc leftovers, etc.).
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
        sys.stdout.write("\033[?25h")
        sys.stdout.flush()


def prompt_choice(
    label: str,
    choices: list[str],
    default: str | None = None,
    *,
    zero: str | None = "Back",
) -> str:
    """Choice prompt. Choices are 1..N; option 0 is reserved for *zero* (default Back).

    On an interactive TTY, supports ↑/↓ + Enter with a live highlight. Number keys
    remain a fallback (same 0..N mapping). Non-TTY / piped input uses the classic
    ``Choose N:`` line prompt.

    Pass ``zero="Quit"`` for the main menu, or ``zero=None`` to hide option 0.
    Selecting 0 returns the *zero* label string (e.g. ``"Back"`` / ``"Quit"``).
    """
    if not choices:
        return prompt_text(label, default)
    use_arrows = (
        sys.stdin.isatty()
        and sys.stdout.isatty()
        and sys.stdin.fileno() >= 0
    )
    if use_arrows:
        try:
            import termios  # noqa: F401 — availability probe for non-Unix hosts
            import tty  # noqa: F401
        except ImportError:
            use_arrows = False
    if use_arrows:
        return _prompt_choice_interactive(label, choices, default, zero)
    return _prompt_choice_numbered(label, choices, default, zero)


def prompt_pick(
    label: str,
    choices: list[str],
    default: str | None = None,
    *,
    zero: str | None = "Back",
) -> str:
    """Like ``prompt_choice``, but selecting 0 raises ``WizardBack`` (cancel/back)."""
    value = prompt_choice(label, choices, default, zero=zero)
    if zero is not None and value == zero:
        raise WizardBack()
    return value

def available_php_versions() -> list[str]:
    from bento.services.php_versions import managed_php_versions

    return managed_php_versions(load_db())

def parse_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]

def print_plan(lines: list[str]) -> None:
    print_heading("Plan", marker="-", leading_blank=True, writer=info)
    print_list(lines, writer=info)

def cmd_status(args: argparse.Namespace) -> None:
    db = load_db()
    from bento.services.mysql_versions import managed_mysql_versions, mysql_service_for

    php_services = [service for version in available_php_versions() for service in (php_service_for(version), php_service_for(version) + "-runner")]
    mysql_services = [mysql_service_for(version) for version in managed_mysql_versions(db)]
    services = [*mysql_services, "redis", "nginx", *php_services]
    running = running_services()
    info("bento status\n")
    info("Docker services:")
    if not docker_available():
        info("  docker: not found")
    else:
        print_table(
            [[service, "running" if service in running else "-"] for service in services],
            headers=["SERVICE", "STATE"],
            prefix="  ",
        )
    info("\nApps:")
    apps = db.get("apps", {})
    if not apps:
        info("  none")
    else:
        app_rows = []
        for name, app in sorted(apps.items()):
            if not isinstance(app, dict):
                continue
            tls = ""
            tls_block = app.get("tls")
            if isinstance(tls_block, dict):
                tls = str(tls_block.get("mode", "") or "")
            app_rows.append(
                [
                    name,
                    str(app.get("php_version", "") or ""),
                    str(app.get("fpm_profile", "") or ""),
                    str(app.get("php_entrypoint", "") or ""),
                    str(app.get("main_domain", "-") or "-"),
                    tls,
                ]
            )
        print_table(
            app_rows,
            headers=["APP", "PHP", "FPM", "ENTRYPOINT", "MAIN", "TLS"],
            prefix="  ",
        )
    proxies = [s for s in db.get("sites", {}).values() if isinstance(s, dict) and s.get("type") == "proxy"]
    if proxies:
        info("\nProxies:")
        proxy_rows = []
        for site in sorted(proxies, key=lambda s: str(s.get("domain"))):
            tls = ""
            tls_block = site.get("tls")
            if isinstance(tls_block, dict):
                tls = str(tls_block.get("mode", "") or "")
            proxy_rows.append([str(site.get("domain", "") or ""), str(site.get("upstream", "") or ""), tls])
        print_table(proxy_rows, headers=["DOMAIN", "UPSTREAM", "TLS"], prefix="  ")
    capacity = fpm_capacity_warnings(db)
    if capacity:
        info("\nPHP-FPM capacity:")
        for message in capacity:
            warn(f"  {message}")
    info("\nQuick checks:")
    info(f"  metadata: bento/{rel(DB_PATH)} {'exists' if DB_PATH.exists() else 'missing'}")
    info(f"  vhosts:   bento/{rel(NGINX_VHOST_DIR)}")
    info(f"  process.max (PHP-FPM global): {php_fpm_process_max()}")
    for mysql_service in mysql_services:
        if mysql_service in running:
            ok = mysql_admin_ping(mysql_service)
            info(f"  {mysql_service} ping: {'ok' if ok else 'failed'}")
            info(f"  {mysql_service} logs: bento/{rel(mysql_log_dir(mysql_service))}")
    if args.check_nginx and "nginx" in running:
        run([*compose_prefix(), "exec", "-T", "nginx", "nginx", "-t"])
