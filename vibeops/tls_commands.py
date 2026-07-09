"""TLS command handlers."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from vibeops.helpers import *  # noqa: F403

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


def vhost_for_domain(domain: str, db: dict[str, Any]) -> tuple[Path, dict[str, Any] | None]:
    owner = db.get("domains", {}).get(domain)
    if owner and owner.get("kind") == "php":
        app = db.get("apps", {}).get(owner.get("app"))
        if not isinstance(app, dict):
            die(f"Domain {domain} points to missing app {owner.get('app')}")
        return ROOT / str(app.get("vhost", rel(app_vhost_path(str(app.get("name")))))), app
    if owner and owner.get("kind") == "proxy":
        site = db.get("sites", {}).get(owner.get("domain"))
        if isinstance(site, dict):
            return ROOT / str(site.get("vhost", rel(NGINX_VHOST_DIR / f"{owner.get('domain')}.conf"))), site
    site = db.get("sites", {}).get(domain)
    if isinstance(site, dict):
        return ROOT / str(site.get("vhost", rel(NGINX_VHOST_DIR / f"{domain}.conf"))), site
    return NGINX_VHOST_DIR / f"{domain}.conf", None


def cmd_tls_acme(args: argparse.Namespace) -> None:
    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path, record = vhost_for_domain(main_domain, db)
    if not conf_path.exists():
        die(f"Missing vhost: vibeops/{rel(conf_path)}")
    if args.off:
        replacement = template_text(NGINX_TEMPLATE_DIR / "tls-self-signed.conf.template", {})
        mode = "self-signed"
    else:
        replacement = template_text(NGINX_TEMPLATE_DIR / "tls-acme.conf.template", {})
        mode = "acme"
    replace_tls_block(conf_path, replacement)
    set_https_redirect(conf_path, mode == "acme" and not args.no_redirect_https)
    record = record or db["sites"].setdefault(main_domain, {"domain": main_domain, "vhost": rel(conf_path)})
    record["tls"] = {"mode": mode, "redirect_https": mode == "acme" and not args.no_redirect_https}
    upsert_timestamp(record)
    save_db(db)
    info(("Enabled NGINX ACME for" if mode == "acme" else "Switched to self-signed certificate for") + f" {main_domain}")
    nginx_reload(args.no_reload)


def cmd_tls_cert(args: argparse.Namespace) -> None:
    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path, record = vhost_for_domain(main_domain, db)
    if not conf_path.exists():
        die(f"Missing vhost: vibeops/{rel(conf_path)}")
    cert_path = args.cert or f"/etc/letsencrypt/live/{main_domain}/fullchain.pem"
    key_path = args.key or f"/etc/letsencrypt/live/{main_domain}/privkey.pem"
    replacement = template_text(NGINX_TEMPLATE_DIR / "tls-files.conf.template", {
        "CERT_PATH": cert_path,
        "CERT_KEY_PATH": key_path,
    })
    replace_tls_block(conf_path, replacement)

    for container_path, label in [(cert_path, "cert"), (key_path, "key")]:
        if container_path.startswith("/etc/letsencrypt/"):
            host_path = CERTS_DIR / container_path.removeprefix("/etc/letsencrypt/")
            if not host_path.exists():
                warn(f"expected host {label} file vibeops/{rel(host_path)} was not found")

    record = record or db["sites"].setdefault(main_domain, {"domain": main_domain, "vhost": rel(conf_path)})
    record["tls"] = {"mode": "files", "cert": cert_path, "key": key_path}
    upsert_timestamp(record)
    save_db(db)
    info(f"Switched {main_domain} to certificate files:")
    info(f"  cert: {cert_path}")
    info(f"  key:  {key_path}")
    nginx_reload(args.no_reload)
