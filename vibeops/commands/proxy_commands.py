"""Reverse proxy commands."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from vibeops.utils.errors import die, info
from vibeops.services.nginx import apply_vhost_tls, assert_domain_free, domains_for, normalize_aliases
from vibeops.utils.paths import NGINX_TEMPLATE_DIR, NGINX_VHOST_DIR, RenderContext, rel
from vibeops.services.rendering import render_template
from vibeops.services.state import load_db, save_db, serialized_cron_state, upsert_timestamp
from vibeops.utils.validation import DOMAIN_RE, validate

def render_proxy_vhost(site: dict[str, Any], ctx: RenderContext | None = None) -> Path:
    main_domain = str(site["domain"])
    aliases = [str(alias) for alias in (site.get("aliases") or [])]
    server_domains = [main_domain, *aliases]
    server_names = " ".join(server_domains)
    conf_path = (ctx.proxy_vhost_path(main_domain) if ctx is not None else NGINX_VHOST_DIR / f"{main_domain}.conf")
    render_template(NGINX_TEMPLATE_DIR / "proxy.conf.template", conf_path, {
        "MAIN_DOMAIN": main_domain,
        "SERVER_NAMES": server_names,
        "SERVER_DOMAINS": server_domains,
        "UPSTREAM": site.get("upstream", ""),
    })
    apply_vhost_tls(conf_path, site)
    site["vhost"] = rel(NGINX_VHOST_DIR / f"{main_domain}.conf")
    return conf_path

@serialized_cron_state
def cmd_proxy_create(args: argparse.Namespace) -> None:
    from vibeops.commands.runtime_commands import SERVICE_TARGETS_NGINX, apply_generated_config

    db = load_db()
    main_domain = validate(args.domain, DOMAIN_RE, "domain")
    upstream = args.upstream
    if not upstream:
        die("upstream is required")
    aliases = normalize_aliases(args.alias, args.aliases)
    for domain in domains_for(main_domain, aliases):
        assert_domain_free(domain, db, allow_domain=main_domain)

    site = db["sites"].setdefault(main_domain, {})
    site.update({
        "type": "proxy",
        "domain": main_domain,
        "aliases": aliases,
        "upstream": upstream,
        "tls": site.get("tls", {"mode": "self-signed"}),
    })
    new_domains = set(domains_for(main_domain, aliases))
    for old_domain, owner in list(db.get("domains", {}).items()):
        if owner.get("kind") == "proxy" and owner.get("domain") == main_domain and old_domain not in new_domains:
            db["domains"].pop(old_domain, None)
    for domain in sorted(new_domains):
        db["domains"][domain] = {"kind": "proxy", "domain": main_domain}
    upsert_timestamp(site)
    # Proxy vhosts are nginx-only; do not bounce PHP-FPM or cron.
    rendered = apply_generated_config(
        db,
        reload_services=not args.no_reload,
        validate_services=True,
        service_targets=SERVICE_TARGETS_NGINX,
    )
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    save_db(db)
    info(f"Created HTTP+HTTPS proxy vhost with default self-signed cert: vibeops/{rel(conf_path)}")
    info(f"Rendered {len(rendered)} generated file(s)")
