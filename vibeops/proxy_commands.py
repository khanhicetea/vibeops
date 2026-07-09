"""Reverse proxy commands."""
from __future__ import annotations

from pathlib import Path

from vibeops.helpers import *  # noqa: F403

def render_proxy_vhost(site: dict[str, Any]) -> Path:
    main_domain = str(site["domain"])
    aliases = [str(alias) for alias in (site.get("aliases") or [])]
    server_domains = [main_domain, *aliases]
    server_names = " ".join(server_domains)
    conf_path = NGINX_VHOST_DIR / f"{main_domain}.conf"
    render_template(NGINX_TEMPLATE_DIR / "proxy.conf.template", conf_path, {
        "MAIN_DOMAIN": main_domain,
        "SERVER_NAMES": server_names,
        "SERVER_DOMAINS": server_domains,
        "UPSTREAM": site.get("upstream", ""),
    })
    apply_vhost_tls(conf_path, site)
    site["vhost"] = rel(conf_path)
    return conf_path


def cmd_proxy_create(args: argparse.Namespace) -> None:
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
    conf_path = render_proxy_vhost(site)
    info(f"Created HTTP+HTTPS proxy vhost with default self-signed cert: vibeops/{rel(conf_path)}")
    new_domains = set(domains_for(main_domain, aliases))
    for old_domain, owner in list(db.get("domains", {}).items()):
        if owner.get("kind") == "proxy" and owner.get("domain") == main_domain and old_domain not in new_domains:
            db["domains"].pop(old_domain, None)
    for domain in sorted(new_domains):
        db["domains"][domain] = {"kind": "proxy", "domain": main_domain}
    upsert_timestamp(site)
    save_db(db)
    nginx_reload(args.no_reload)
