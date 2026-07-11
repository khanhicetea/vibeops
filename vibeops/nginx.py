"""Nginx vhost/TLS mutation and reload helpers."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

from vibeops.env import default_php_version
from vibeops.errors import die, info, warn
from vibeops.fsutil import write_text
from vibeops.paths import NGINX_TEMPLATE_DIR, NGINX_VHOST_DIR, RenderContext, rel
from vibeops.php import container_document_root, php_service_for
from vibeops.process import run, service_running
from vibeops.rendering import render_template, template_text
from vibeops.validation import DOMAIN_RE, validate, validate_php_entrypoint, validate_public_dir

def nginx_reload(no_reload: bool = False) -> None:
    if no_reload:
        return
    if service_running("nginx"):
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"])
        run(["docker", "compose", "exec", "-T", "nginx", "nginx", "-s", "reload"])
        info("Reloaded nginx")
    else:
        info("nginx container is not running; start it then run: docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload")


def app_vhost_path(app_name: str, ctx: RenderContext | None = None) -> Path:
    if ctx is not None:
        return ctx.app_vhost_path(app_name)
    return NGINX_VHOST_DIR / f"app-{app_name}.conf"


def normalize_aliases(alias: Iterable[str] | None, aliases: str | None) -> list[str]:
    out: list[str] = []
    for value in alias or []:
        for item in value.split(","):
            item = item.strip()
            if item:
                out.append(validate(item, DOMAIN_RE, "alias domain"))
    if aliases:
        for item in aliases.split(","):
            item = item.strip()
            if item:
                out.append(validate(item, DOMAIN_RE, "alias domain"))
    return sorted(dict.fromkeys(out))


def domains_for(main_domain: str, aliases: Iterable[str]) -> list[str]:
    ordered = [main_domain, *aliases]
    return list(dict.fromkeys(ordered))


def assert_domain_free(domain: str, db: dict[str, Any], *, allow_app: str | None = None, allow_domain: str | None = None) -> None:
    owner = db.get("domains", {}).get(domain)
    if not owner:
        return
    if owner.get("kind") == "php" and allow_app and owner.get("app") == allow_app:
        return
    if owner.get("kind") == "proxy" and allow_domain and owner.get("domain") == allow_domain:
        return
    die(f"Domain already exists in stack.json: {domain} ({owner.get('kind')})")


def tls_replacement(tls: dict[str, Any] | None) -> str:
    tls = tls or {"mode": "self-signed"}
    mode = tls.get("mode", "self-signed")
    if mode == "acme":
        return template_text(NGINX_TEMPLATE_DIR / "tls-acme.conf.template", {})
    if mode == "files":
        return template_text(NGINX_TEMPLATE_DIR / "tls-files.conf.template", {
            "CERT_PATH": tls.get("cert", ""),
            "CERT_KEY_PATH": tls.get("key", ""),
        })
    return template_text(NGINX_TEMPLATE_DIR / "tls-self-signed.conf.template", {})


def apply_vhost_tls(conf_path: Path, record: dict[str, Any]) -> None:
    tls = record.get("tls") if isinstance(record.get("tls"), dict) else {"mode": "self-signed"}
    replace_tls_block(conf_path, tls_replacement(tls))
    set_https_redirect(conf_path, bool(tls.get("redirect_https")) and tls.get("mode") in {"acme", "files"}, quiet=True)


def replace_tls_block(conf_path: Path, replacement: str) -> None:
    text = conf_path.read_text()
    text2, count = re.subn(r"# BEGIN TLS_CERTIFICATE\n.*?\n\s*# END TLS_CERTIFICATE", lambda _: replacement, text, count=1, flags=re.S)
    if count != 1:
        die(f"Could not find marked TLS certificate block in {rel(conf_path)}")
    write_text(conf_path, text2)


def set_https_redirect(conf_path: Path, enabled: bool, *, quiet: bool = False) -> None:
    """Toggle the generated HTTP vhost redirect flag."""
    text = conf_path.read_text()
    value = "1" if enabled else "0"

    if "set $enable_https_redirect" in text:
        text2, count = re.subn(r"set \$enable_https_redirect [01];", f"set $enable_https_redirect {value};", text, count=1)
    else:
        listen_pos = text.find("listen 80;")
        server_name_pos = text.find("server_name ", listen_pos)
        insert_pos = text.find(";", server_name_pos) + 1 if server_name_pos >= 0 else 0
        if listen_pos < 0 or server_name_pos < 0 or insert_pos <= 0:
            warn(f"Could not find generated HTTP server in {rel(conf_path)}; skipped HTTPS redirect toggle")
            return
        text2 = text[:insert_pos] + f"\n\n    set $enable_https_redirect {value};" + text[insert_pos:]
        count = 1

    if count and text2 != text:
        write_text(conf_path, text2)
        if not quiet:
            info(("Enabled" if enabled else "Disabled") + f" HTTP to HTTPS redirect in vibeops/{rel(conf_path)}")


def render_app_vhost(app: dict[str, Any], ctx: RenderContext | None = None) -> Path:
    app_name = str(app["name"])
    domains = [str(d) for d in (app.get("domains") or [app.get("main_domain")]) if d]
    server_names = " ".join(domains)
    conf_path = app_vhost_path(app_name, ctx)
    public_dir = validate_public_dir(str(app.get("public_dir", "")))
    php_service = app.get("php_service") or php_service_for(str(app.get("php_version") or default_php_version()))
    php_entrypoint = validate_php_entrypoint(str(app.get("php_entrypoint") or "auto"), public_dir)
    app["php_entrypoint"] = php_entrypoint
    render_template(NGINX_TEMPLATE_DIR / "site.conf.template", conf_path, {
        "USERNAME": app_name,
        "APP_NAME": app_name,
        "MAIN_DOMAIN": app.get("main_domain", ""),
        "SERVER_NAMES": server_names,
        "SERVER_DOMAINS": domains,
        "PHP_SERVICE": php_service,
        "PHP_FRONT_CONTROLLER": php_entrypoint == "front-controller",
        "DOCUMENT_ROOT": container_document_root(app_name, public_dir),
    })
    apply_vhost_tls(conf_path, app)
    # State always records the live path so stack.json stays mount-stable.
    app["vhost"] = rel(app_vhost_path(app_name))
    return conf_path
