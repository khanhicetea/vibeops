"""TLS command handlers."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from vibeops.errors import die, info, warn
from vibeops.nginx import app_vhost_path
from vibeops.paths import CERTS_DIR, NGINX_VHOST_DIR, rel
from vibeops.state import load_db, save_db, serialized_cron_state, upsert_timestamp
from vibeops.validation import DOMAIN_RE, validate

def vhost_for_domain(domain: str, db: dict[str, Any]) -> tuple[Path, dict[str, Any] | None]:
    owner = db.get("domains", {}).get(domain)
    if owner and owner.get("kind") == "php":
        app = db.get("apps", {}).get(owner.get("app"))
        if not isinstance(app, dict):
            die(f"Domain {domain} points to missing app {owner.get('app')}")
        return app_vhost_path(str(app.get("name"))), app
    if owner and owner.get("kind") == "proxy":
        site = db.get("sites", {}).get(owner.get("domain"))
        if isinstance(site, dict):
            return NGINX_VHOST_DIR / f"{owner.get('domain')}.conf", site
    site = db.get("sites", {}).get(domain)
    if isinstance(site, dict):
        return NGINX_VHOST_DIR / f"{domain}.conf", site
    return NGINX_VHOST_DIR / f"{domain}.conf", None

@serialized_cron_state
def cmd_tls_acme(args: argparse.Namespace) -> None:
    from vibeops.runtime_commands import apply_generated_config

    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path, record = vhost_for_domain(main_domain, db)
    if record is None:
        die(f"Unknown domain in state: {main_domain}")
    if args.off:
        mode = "self-signed"
    else:
        mode = "acme"
    record["tls"] = {"mode": mode, "redirect_https": mode == "acme" and not args.no_redirect_https}
    upsert_timestamp(record)
    apply_generated_config(db, reload_services=not args.no_reload, validate_services=True)
    save_db(db)
    info(("Enabled NGINX ACME for" if mode == "acme" else "Switched to self-signed certificate for") + f" {main_domain}")
    info(f"Regenerated vhost: vibeops/{rel(conf_path)}")

@serialized_cron_state
def cmd_tls_cert(args: argparse.Namespace) -> None:
    from vibeops.runtime_commands import apply_generated_config

    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    conf_path, record = vhost_for_domain(main_domain, db)
    if record is None:
        die(f"Unknown domain in state: {main_domain}")
    cert_path = args.cert or f"/etc/letsencrypt/live/{main_domain}/fullchain.pem"
    key_path = args.key or f"/etc/letsencrypt/live/{main_domain}/privkey.pem"

    for container_path, label in [(cert_path, "cert"), (key_path, "key")]:
        if container_path.startswith("/etc/letsencrypt/"):
            host_path = CERTS_DIR / container_path.removeprefix("/etc/letsencrypt/")
            if not host_path.exists():
                warn(f"expected host {label} file vibeops/{rel(host_path)} was not found")

    record["tls"] = {"mode": "files", "cert": cert_path, "key": key_path}
    upsert_timestamp(record)
    apply_generated_config(db, reload_services=not args.no_reload, validate_services=True)
    save_db(db)
    info(f"Switched {main_domain} to certificate files:")
    info(f"  cert: {cert_path}")
    info(f"  key:  {key_path}")
    info(f"Regenerated vhost: vibeops/{rel(conf_path)}")
