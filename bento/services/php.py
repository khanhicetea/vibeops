"""PHP service naming, app identity, pool rendering, and FPM reload."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from bento.utils.env import default_fpm_profile, default_mysql_service, default_php_version, fpm_pool_template_values, stack_env, validate_fpm_profile
from bento.utils.errors import die, info
from bento.os.fsutil import mkdir
from bento.services.app_config import selected_template_path
from bento.services.mysql import apply_app_mysql_metadata, create_mysql_user
from bento.services.redis import apply_app_redis_metadata, ensure_redis_user
from bento.utils.paths import DOCROOT_NAME, HOME_DIR, PHP_LOG_DIR, PHP_SOCKET_DIR, PHP_TEMPLATE_DIR, PHP_VERSIONS_DIR, RenderContext, rel
from bento.os.process import run, service_running
from bento.services.rendering import write_template
from bento.services.state import allocate_uid, read_uid_from_env, upsert_timestamp
from bento.utils.validation import APP_NAME_RE, MYSQL_SERVICE_RE, PHP_VERSION_RE, validate, validate_php_entrypoint, validate_public_dir

def php_service_for(version: str) -> str:
    return "php" + version.replace(".", "")


def php_runner_service_for(version: str) -> str:
    return php_service_for(version) + "-runner"


def php_cli_service_for(version: str) -> str:
    return php_service_for(version) + "-cli"


def php_version_config_dir(version: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.php_version_config_dir(version)
    return PHP_VERSIONS_DIR / version


def php_reload(service: str, username: str, no_reload: bool = False) -> None:
    if service_running(service):
        run(["docker", "compose", "exec", "-T", service, "php-identity-sync", username])
        if not no_reload:
            try:
                # php-fpm -tt writes its full configuration dump to stderr even
                # when validation succeeds. Keep app creation output concise.
                run(["docker", "compose", "exec", "-T", service, "php-fpm", "-tt"], capture=True)
                run([
                    "docker", "compose", "exec", "-T", service, "sh", "-lc",
                    "kill -USR2 1",
                ], capture=True)
            except subprocess.CalledProcessError:
                die(f"Failed to validate or reload {service}")
            info(f"Reloaded {service}")
    else:
        info(f"{service} is not running; run/restart it to create the Linux user inside that PHP container.")


def app_home(app_name: str) -> Path:
    return HOME_DIR / app_name


def app_www(app_name: str) -> Path:
    return app_home(app_name) / DOCROOT_NAME


def app_document_root(app_name: str, public_dir: str | None = "") -> Path:
    public_dir = validate_public_dir(public_dir)
    return app_www(app_name) / public_dir if public_dir else app_www(app_name)


def container_document_root(app_name: str, public_dir: str | None = "") -> str:
    public_dir = validate_public_dir(public_dir)
    base = f"/home/{app_name}/{DOCROOT_NAME}"
    return f"{base}/{public_dir}" if public_dir else base


def ensure_app_identity(app_name: str, php_version: str, db: dict[str, Any], *, uid: int | None = None, public_dir: str | None = None, fpm_profile: str | None = None, no_mysql: bool = False, mysql_password: str | None = None, mysql_service: str | None = None, no_reload: bool = False) -> dict[str, Any]:
    app_name = validate(app_name, APP_NAME_RE, "app_name")
    php_version = validate(php_version, PHP_VERSION_RE, "PHP version")
    mysql_service = validate(mysql_service or default_mysql_service(), MYSQL_SERVICE_RE, "MySQL service")
    app_uid = allocate_uid(app_name, uid, db)
    php_service = php_service_for(php_version)
    socket_group_name = stack_env().get("SOCKET_GROUP_NAME", "nginxsock")
    app = db["apps"].setdefault(app_name, {"name": app_name})
    public_dir = validate_public_dir(public_dir if public_dir is not None else str(app.get("public_dir", "")))
    if fpm_profile is not None:
        profile = validate_fpm_profile(fpm_profile)
    else:
        profile = validate_fpm_profile(str(app.get("fpm_profile") or default_fpm_profile()))
    app["uid"] = app_uid
    app["public_dir"] = public_dir
    app["php_entrypoint"] = validate_php_entrypoint(str(app.get("php_entrypoint") or "auto"), public_dir)
    app["fpm_profile"] = profile
    app["php_version"] = php_version
    app["php_service"] = php_service

    # Private dirs: app:app 700 (see php-permissions private_dirs).
    mkdir(app_home(app_name) / "logs", 0o700)
    mkdir(app_www(app_name))
    mkdir(app_home(app_name) / ".credentials", 0o700)
    mkdir(app_home(app_name) / ".composer", 0o700)
    mkdir(app_home(app_name) / ".ssh", 0o700)
    mkdir(php_version_config_dir(php_version) / "users.d")
    mkdir(php_version_config_dir(php_version) / "pool.d")
    from bento.services.cron_runtime import cron_dir_for
    mkdir(cron_dir_for(php_version))
    mkdir(PHP_SOCKET_DIR / php_service)
    mkdir(PHP_LOG_DIR / php_service)

    fallback_path = php_version_config_dir(php_version) / "pool.d" / "zz-fallback.conf"
    if not fallback_path.exists():
        write_template(fallback_path, PHP_TEMPLATE_DIR / "fallback.conf.template", {"SOCKET_GROUP_NAME": socket_group_name}, generated=True)

    write_template(php_version_config_dir(php_version) / "users.d" / f"{app_name}.env", PHP_TEMPLATE_DIR / "user.env.template", {
        "USERNAME": app_name,
        "UID": app_uid,
        "GID": app_uid,
        "PUBLIC_DIR": public_dir,
    }, generated=True)
    pool_values = {
        "USERNAME": app_name,
        "SOCKET_GROUP_NAME": socket_group_name,
        "PHP_VERSION": php_version,
        **fpm_pool_template_values(profile),
    }
    write_template(
        php_version_config_dir(php_version) / "pool.d" / f"{app_name}.conf",
        selected_template_path(app, "pool"),
        pool_values,
        generated=True,
    )
    info(f"Created PHP {php_version} app identity: {app_name} uid={app_uid}")
    info(f"Home: bento/{rel(app_home(app_name))}")
    info(f"Pool: bento/{rel(php_version_config_dir(php_version) / 'pool.d' / f'{app_name}.conf')}")
    info(f"Socket: bento/{rel(PHP_SOCKET_DIR / php_service / f'{app_name}.sock')}")

    php_reload(php_service, app_name, no_reload=no_reload)

    mysql_created = False
    credential_path = None
    if not no_mysql:
        mysql_created, credential_path = create_mysql_user(app_name, mysql_password, mysql_service)
    redis_created, redis_credential_path = ensure_redis_user(app_name)

    app["home"] = rel(app_home(app_name))
    app["root"] = rel(app_document_root(app_name, public_dir))
    versions = set(app.get("php_versions", []))
    versions.add(php_version)
    app["php_versions"] = sorted(versions)
    app.setdefault("databases", [])
    app.setdefault("tls", {"mode": "self-signed"})
    apply_app_mysql_metadata(app, app_name, mysql_service, credential_path)
    apply_app_redis_metadata(app, app_name, redis_credential_path)
    if mysql_created:
        app["mysql_user"] = True
    if redis_created:
        app["redis_acl_user"] = True
    upsert_timestamp(app)
    return app


def render_php_fallback(php_version: str, ctx: RenderContext | None = None) -> Path:
    php_version = validate(php_version, PHP_VERSION_RE, "PHP version")
    socket_group_name = stack_env().get("SOCKET_GROUP_NAME", "nginxsock")
    base = php_version_config_dir(php_version, ctx)
    mkdir(base / "pool.d")
    fallback_path = base / "pool.d" / "zz-fallback.conf"
    write_template(fallback_path, PHP_TEMPLATE_DIR / "fallback.conf.template", {"SOCKET_GROUP_NAME": socket_group_name}, generated=True)
    return fallback_path


def render_app_identity(app: dict[str, Any], ctx: RenderContext | None = None) -> None:
    app_name = validate(str(app.get("name", "")), APP_NAME_RE, "app_name")
    php_version = validate(str(app.get("php_version") or default_php_version()), PHP_VERSION_RE, "PHP version")
    php_service = php_service_for(php_version)
    # Prefer recorded UID, then live identity files (not staging), then allocate.
    uid = int(
        app.get("uid")
        or read_uid_from_env(PHP_VERSIONS_DIR / php_version / "users.d" / f"{app_name}.env")
        or allocate_uid(app_name, None, {"apps": {app_name: app}})
    )
    socket_group_name = stack_env().get("SOCKET_GROUP_NAME", "nginxsock")
    base = php_version_config_dir(php_version, ctx)
    mkdir(base / "users.d")
    mkdir(base / "pool.d")
    mkdir(PHP_SOCKET_DIR / php_service)
    mkdir(PHP_LOG_DIR / php_service)
    render_php_fallback(php_version, ctx)
    public_dir = validate_public_dir(str(app.get("public_dir", "")))
    fpm_profile = validate_fpm_profile(str(app.get("fpm_profile") or default_fpm_profile()))
    write_template(base / "users.d" / f"{app_name}.env", PHP_TEMPLATE_DIR / "user.env.template", {
        "USERNAME": app_name,
        "UID": uid,
        "GID": uid,
        "PUBLIC_DIR": public_dir,
    }, generated=True)
    write_template(base / "pool.d" / f"{app_name}.conf", selected_template_path(app, "pool"), {
        "USERNAME": app_name,
        "SOCKET_GROUP_NAME": socket_group_name,
        "PHP_VERSION": php_version,
        **fpm_pool_template_values(fpm_profile),
    }, generated=True)
    app["uid"] = uid
    app["php_service"] = php_service
    app["home"] = rel(app_home(app_name))
    app["public_dir"] = public_dir
    app["php_entrypoint"] = validate_php_entrypoint(str(app.get("php_entrypoint") or "auto"), public_dir)
    app["fpm_profile"] = fpm_profile
    app["root"] = rel(app_document_root(app_name, public_dir))
