"""Redis ACL account provisioning and app credential files."""
from __future__ import annotations

import re
from typing import Any

from bento.os.fsutil import mkdir
from bento.os.process import run, service_running
from bento.services.mysql import generate_password
from bento.services.rendering import write_template
from bento.utils.env import stack_env
from bento.utils.errors import die, info
from bento.utils.paths import CONFIG_DIR, HOME_DIR, rel
from bento.utils.validation import APP_NAME_RE, validate

_SAFE_PASSWORD_RE = re.compile(r"^[A-Za-z0-9._~-]+$")


def _resp(*parts: str) -> str:
    encoded = [f"*{len(parts)}\r\n"]
    for part in parts:
        raw = part.encode()
        encoded.append(f"${len(raw)}\r\n{part}\r\n")
    return "".join(encoded)


def validate_redis_password(value: str, field: str) -> str:
    if not value or not _SAFE_PASSWORD_RE.fullmatch(value):
        die(f"{field} must contain only A-Z, a-z, 0-9, '.', '_', '~', '-'")
    return value


def redis_acl_exec(*command: str) -> None:
    admin_password = validate_redis_password(stack_env().get("REDIS_ADMIN_PASSWORD", ""), "REDIS_ADMIN_PASSWORD")
    payload = _resp("AUTH", "admin", admin_password) + _resp(*command)
    cp = run(["docker", "compose", "exec", "-T", "redis", "redis-cli", "--pipe"], input_text=payload, check=False, capture=True)
    output = f"{cp.stdout or ''}\n{cp.stderr or ''}"
    if cp.returncode != 0 or "errors: 0" not in output:
        die("Redis ACL command failed; inspect docker compose logs redis")


def ensure_redis_user(app_name: str) -> tuple[bool, str]:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    env = stack_env()
    acl_enabled = env.get("REDIS_APP_ACL", "false").strip().lower() == "true"
    cred_dir = HOME_DIR / app_name / ".credentials"
    cred_path = cred_dir / "redis.env"
    if acl_enabled:
        # Always mint a unique per-app secret. Admin auth stays on REDIS_ADMIN_PASSWORD.
        password = validate_redis_password(generate_password(32), "REDIS_PASSWORD")
        username = app_name
    else:
        password = env.get("REDIS_PASSWORD", "")
        if password:
            validate_redis_password(password, "REDIS_PASSWORD")
        username = ""
    mkdir(cred_dir, 0o700)
    write_template(cred_path, CONFIG_DIR / "redis-credentials.env.template", {
        "REDIS_USERNAME": username,
        "REDIS_PASSWORD": password,
        "REDIS_PREFIX": f"{app_name}:",
    }, 0o600)
    if not acl_enabled:
        info(f"Shared Redis credentials saved (mode 600): bento/{rel(cred_path)}")
        return False, rel(cred_path)
    if not service_running("redis"):
        info("Redis is not running; credentials were saved but ACL provisioning is pending. Re-run app create after Redis starts.")
        return False, rel(cred_path)
    redis_acl_exec("ACL", "SETUSER", app_name, "reset", "on", f">{password}", f"~{app_name}:*", f"&{app_name}:*", "+@all", "-@admin", "-@dangerous")
    redis_acl_exec("ACL", "SAVE")
    info(f"Redis ACL account ready: user={app_name}, keys={app_name}:*")
    info(f"Redis credentials saved (mode 600): bento/{rel(cred_path)}")
    return True, rel(cred_path)


def apply_app_redis_metadata(app: dict[str, Any], app_name: str, credential_path: str | None = None) -> None:
    app["redis_host"] = "redis"
    app["redis_port"] = 6379
    app["redis_user"] = app_name if stack_env().get("REDIS_APP_ACL", "false").strip().lower() == "true" else ""
    app["redis_db"] = 0
    app["redis_prefix"] = f"{app_name}:"
    if credential_path:
        app["redis_credentials"] = credential_path
