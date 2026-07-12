"""Desired-state load/save, locks, timestamps, and UID allocation."""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from typing import Any, Iterator

from bento.utils.env import default_fpm_profile, default_mysql_service, default_php_version, validate_fpm_profile
from bento.services.app_config import normalize_service_config
from bento.utils.errors import die
from bento.os.fsutil import mkdir
from bento.utils.paths import DB_PATH, NGINX_VHOST_DIR, PHP_VERSIONS_DIR, SCHEMA_VERSION, STATE_DIR, now, rel
from bento.utils.validation import default_php_entrypoint, validate_php_entrypoint, validate_public_dir

def empty_db() -> dict[str, Any]:
    return {
        "schema": SCHEMA_VERSION,
        "defaults": {
            "php_version": default_php_version(),
            "mysql_service": default_mysql_service(),
        },
        "apps": {},
        "domains": {},
        "sites": {},
        "crons": {},
        "workers": {},
        "updated_at": now(),
    }


def state_path() -> Path:
    return DB_PATH


def normalize_db(data: dict[str, Any]) -> dict[str, Any]:
    schema = int(data.get("schema", 0) or 0)
    if schema > SCHEMA_VERSION:
        die(f"state schema is {schema}; this CLI expects schema {SCHEMA_VERSION}")
    data["schema"] = SCHEMA_VERSION
    data.setdefault("defaults", {})
    data["defaults"].setdefault("php_version", default_php_version())
    data["defaults"].setdefault("mysql_service", default_mysql_service())
    data.setdefault("apps", {})
    data.setdefault("domains", {})
    data.setdefault("sites", {})
    data.setdefault("crons", {})
    data.setdefault("workers", {})
    # Drop unused pre-v1 keys if present in hand-edited state.
    data.pop("users", None)
    for app_name, app in data.get("apps", {}).items():
        if isinstance(app, dict):
            app.setdefault("name", app_name)
            public_dir = validate_public_dir(str(app.get("public_dir", "")))
            app["public_dir"] = public_dir
            app.setdefault("php_entrypoint", default_php_entrypoint(public_dir))
            app["php_entrypoint"] = validate_php_entrypoint(str(app.get("php_entrypoint") or "auto"), public_dir)
            app["fpm_profile"] = validate_fpm_profile(str(app.get("fpm_profile") or default_fpm_profile()))
            app["access_log"] = bool(app.get("access_log"))
            if "service_config" in app:
                app["service_config"] = normalize_service_config(app_name, app.get("service_config"))
            if app.get("vhost"):
                from bento.services.nginx import app_vhost_path
                app["vhost"] = rel(app_vhost_path(app_name))
    for domain, site in data.get("sites", {}).items():
        if isinstance(site, dict) and site.get("type") == "proxy":
            site.setdefault("domain", domain)
            site["vhost"] = rel(NGINX_VHOST_DIR / f"{domain}.conf")
    return data


def load_db() -> dict[str, Any]:
    path = state_path()
    if not path.exists():
        return empty_db()
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        die(f"Cannot parse {rel(path)}: {exc}")
    if not isinstance(data, dict):
        die(f"{rel(path)} must contain a JSON object")
    return normalize_db(data)


def save_db(data: dict[str, Any]) -> None:
    normalize_db(data)
    data["schema"] = SCHEMA_VERSION
    data["updated_at"] = now()
    text = json.dumps(data, indent=2, sort_keys=True) + "\n"
    mkdir(DB_PATH.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=".stack.", suffix=".json", dir=str(DB_PATH.parent))
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


@contextmanager
def cron_state_lock() -> Iterator[None]:
    """Serialize cron/worker state, render, and runner reconciliation mutations."""
    lock_path = STATE_DIR / ".cron.lock"
    mkdir(lock_path.parent)
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def serialized_cron_state(func: Any) -> Any:
    """Decorator for render/apply operations that replace runner artifacts."""
    @wraps(func)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        with cron_state_lock():
            return func(*args, **kwargs)
    return wrapped


def read_uid_from_env(path: Path) -> int | None:
    try:
        for line in path.read_text().splitlines():
            if line.startswith("UID="):
                return int(line.split("=", 1)[1])
    except Exception:
        return None
    return None


def allocate_uid(app_name: str, explicit_uid: int | None, db: dict[str, Any]) -> int:
    if explicit_uid is not None:
        return explicit_uid

    existing = db.get("apps", {}).get(app_name, {}).get("uid")
    if isinstance(existing, int):
        return existing

    for path in sorted(PHP_VERSIONS_DIR.glob(f"*/users.d/{app_name}.env")):
        uid = read_uid_from_env(path)
        if uid is not None:
            return uid

    max_uid = 0
    for app in db.get("apps", {}).values():
        uid = app.get("uid") if isinstance(app, dict) else None
        if isinstance(uid, int):
            max_uid = max(max_uid, uid)
    for path in PHP_VERSIONS_DIR.glob("*/users.d/*.env"):
        uid = read_uid_from_env(path)
        if uid is not None:
            max_uid = max(max_uid, uid)
    return 10000 if max_uid < 10000 else max_uid + 1
