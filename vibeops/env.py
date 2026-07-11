"""Environment parsing, stack defaults, and FPM profile registry."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from vibeops.errors import die
from vibeops.paths import ROOT

# Named PHP-FPM pool profiles. Store only the name in app state; render concrete pm.*
# directives from this registry. Do not accept arbitrary pool fragments from state.
FPM_PROFILES: dict[str, dict[str, Any]] = {
    "ondemand": {
        "pm": "ondemand",
        "max_children": 4,
        "process_idle_timeout": "10s",
        "max_requests": 256,
    },
    "balanced": {
        "pm": "dynamic",
        "max_children": 6,
        "start_servers": 2,
        "min_spare_servers": 1,
        "max_spare_servers": 3,
        "max_requests": 256,
    },
    "throughput": {
        "pm": "dynamic",
        "max_children": 12,
        "start_servers": 3,
        "min_spare_servers": 2,
        "max_spare_servers": 6,
        "max_requests": 512,
    },
}

FPM_PROFILE_NAMES = tuple(FPM_PROFILES.keys())

DEFAULT_FPM_PROFILE = "balanced"

DEFAULT_PHP_FPM_PROCESS_MAX = 32


def parse_env_file(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            env[key] = value
    return env


def stack_env() -> dict[str, str]:
    env = parse_env_file(ROOT / ".env")
    merged = dict(env)
    merged.update(os.environ)
    return merged


def default_php_version() -> str:
    return stack_env().get("DEFAULT_PHP_VERSION", "8.4")


def default_mysql_service() -> str:
    return stack_env().get("DEFAULT_MYSQL_SERVICE", "mysql84")


def default_fpm_profile() -> str:
    """Stack default FPM profile for new apps (DEFAULT_FPM_PROFILE, else balanced)."""
    raw = stack_env().get("DEFAULT_FPM_PROFILE", DEFAULT_FPM_PROFILE).strip() or DEFAULT_FPM_PROFILE
    return validate_fpm_profile(raw)


def validate_fpm_profile(value: str | None) -> str:
    name = (value or "").strip().lower()
    if name not in FPM_PROFILES:
        known = ", ".join(FPM_PROFILE_NAMES)
        die(f"Invalid fpm_profile: {value!r}; expected one of: {known}")
    return name


def fpm_profile_spec(profile: str | None) -> dict[str, Any]:
    name = validate_fpm_profile(profile)
    return dict(FPM_PROFILES[name])


def fpm_profile_max_children(profile: str | None) -> int:
    return int(fpm_profile_spec(profile)["max_children"])


def fpm_pool_template_values(profile: str | None) -> dict[str, Any]:
    """Flat template values for pool.conf.template from a named profile."""
    name = validate_fpm_profile(profile)
    spec = FPM_PROFILES[name]
    pm = str(spec["pm"])
    is_ondemand = pm == "ondemand"
    values: dict[str, Any] = {
        "FPM_PROFILE": name,
        "PM": pm,
        "PM_IS_ONDEMAND": is_ondemand,
        "PM_MAX_CHILDREN": int(spec["max_children"]),
        "PM_MAX_REQUESTS": int(spec["max_requests"]),
    }
    if is_ondemand:
        values["PM_PROCESS_IDLE_TIMEOUT"] = str(spec["process_idle_timeout"])
        # Placeholders so missing-key errors never fire if template branches change.
        values.setdefault("PM_START_SERVERS", 0)
        values.setdefault("PM_MIN_SPARE_SERVERS", 0)
        values.setdefault("PM_MAX_SPARE_SERVERS", 0)
    else:
        values["PM_START_SERVERS"] = int(spec["start_servers"])
        values["PM_MIN_SPARE_SERVERS"] = int(spec["min_spare_servers"])
        values["PM_MAX_SPARE_SERVERS"] = int(spec["max_spare_servers"])
        values.setdefault("PM_PROCESS_IDLE_TIMEOUT", "0s")
    return values


def php_fpm_process_max() -> int:
    """Global PHP-FPM process.max (image default 32; overridable via PHP_FPM_PROCESS_MAX)."""
    raw = stack_env().get("PHP_FPM_PROCESS_MAX", str(DEFAULT_PHP_FPM_PROCESS_MAX)).strip()
    try:
        value = int(raw)
    except ValueError:
        die(f"Invalid PHP_FPM_PROCESS_MAX: {raw!r}; expected a positive integer")
    if value < 1:
        die(f"Invalid PHP_FPM_PROCESS_MAX: {value}; expected a positive integer")
    return value


def fpm_capacity_warnings(db: dict[str, Any], *, process_max: int | None = None) -> list[str]:
    """Warn when sum of per-pool max_children on one PHP version exceeds process.max."""
    cap = process_max if process_max is not None else php_fpm_process_max()
    by_version: dict[str, list[tuple[str, str, int]]] = {}
    for app_name, app in (db.get("apps") or {}).items():
        if not isinstance(app, dict):
            continue
        version = str(app.get("php_version") or default_php_version())
        profile = validate_fpm_profile(str(app.get("fpm_profile") or default_fpm_profile()))
        max_children = fpm_profile_max_children(profile)
        by_version.setdefault(version, []).append((str(app_name), profile, max_children))
    warnings: list[str] = []
    for version in sorted(by_version):
        rows = by_version[version]
        total = sum(row[2] for row in rows)
        if total > cap:
            detail = ", ".join(f"{name}={profile}:{n}" for name, profile, n in sorted(rows))
            from vibeops.php import php_service_for
            service = php_service_for(version)
            warnings.append(
                f"PHP {version} ({service}): sum of pool pm.max_children is {total} "
                f"across {len(rows)} app(s) but global process.max is {cap} "
                f"({detail}). Extra workers will be refused until capacity is free; "
                f"raise PHP_FPM_PROCESS_MAX (rebuild PHP images) or lower profiles."
            )
    return warnings


def mysql_root_password(env: dict[str, str], service: str) -> str | None:
    return env.get(f"{service.upper()}_ROOT_PASSWORD") or env.get("MYSQL_ROOT_PASSWORD")
