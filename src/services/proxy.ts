/**
 * Reverse-proxy site management.
 */

import type { DesiredState, ProxySite, TlsMode } from "../domain/state.ts";
import { asDomainName, asProxySiteName } from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import { parseAppSlug, parseDomainName, unwrap } from "../schemas/validators.ts";
import { type ReloadPlan, reloadPlanForDomainChange } from "../domain/reload.ts";

export type CreateProxyInput = {
  name: string;
  domain: string;
  aliases?: string[];
  upstreams: string[];
  tls?: TlsMode;
  accessLog?: boolean;
};

export function createProxy(
  state: DesiredState,
  input: CreateProxyInput,
  now: string,
): { state: DesiredState; proxy: ProxySite; reloadPlan: ReloadPlan } {
  const name = unwrap(parseAppSlug(input.name), "name");
  if (state.proxies[name]) {
    throw conflictError(`proxy site ${name} already exists`);
  }
  const domain = unwrap(parseDomainName(input.domain), "domain");
  const aliases = (input.aliases ?? []).map((a, i) => unwrap(parseDomainName(a), `aliases[${i}]`));
  validateUpstreams(input.upstreams);

  for (const d of [domain, ...aliases]) {
    const owner = state.domains[d];
    if (owner) {
      throw conflictError(
        `domain ${d} is already owned by ${
          owner.kind === "app" ? `app ${owner.slug}` : `proxy ${owner.name}`
        }`,
      );
    }
  }

  const proxy: ProxySite = {
    name: asProxySiteName(name),
    mainDomain: asDomainName(domain),
    aliases: aliases.map(asDomainName),
    upstreams: [...input.upstreams],
    tls: input.tls ?? { kind: "boot" },
    accessLog: input.accessLog ?? false,
    createdAt: now,
    updatedAt: now,
  };

  const domains = { ...state.domains };
  for (const d of [domain, ...aliases]) {
    domains[d] = { kind: "proxy", name: asProxySiteName(name) };
  }

  return {
    state: {
      ...state,
      proxies: { ...state.proxies, [name]: proxy },
      domains,
      updatedAt: now,
    },
    proxy,
    reloadPlan: reloadPlanForDomainChange(),
  };
}

export type NginxUpstreamConfig = {
  scheme: "http" | "https";
  servers: string[];
  uri: string;
};

/** Validate proxy targets and derive values safe for an Nginx upstream block. */
export function validateUpstreams(upstreams: string[]): NginxUpstreamConfig {
  if (upstreams.length === 0) {
    throw validationError("at least one upstream is required");
  }

  const urls = upstreams.map((upstream, index) => {
    let url: URL;
    try {
      url = new URL(upstream);
    } catch {
      throw validationError(`upstream[${index}] must be a valid http(s) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw validationError(`upstream[${index}] must be an http(s) URL`);
    }
    if (url.username || url.password || url.hash) {
      throw validationError(`upstream[${index}] must not contain credentials or a fragment`);
    }
    return url;
  });

  const first = urls[0]!;
  const uri = `${first.pathname === "/" ? "" : first.pathname}${first.search}`;
  if (/[\s;{}]/.test(uri)) {
    throw validationError("upstream path/query contains characters unsafe for Nginx");
  }
  for (const [index, url] of urls.entries()) {
    const candidateUri = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    if (url.protocol !== first.protocol) {
      throw validationError(`upstream[${index}] must use the same protocol as upstream[0]`);
    }
    if (candidateUri !== uri) {
      throw validationError(`upstream[${index}] must use the same path and query as upstream[0]`);
    }
  }

  return {
    scheme: first.protocol.slice(0, -1) as "http" | "https",
    servers: urls.map((url) =>
      url.port ? url.host : `${url.hostname}:${url.protocol === "https:" ? "443" : "80"}`
    ),
    uri,
  };
}

export function getProxyOrThrow(state: DesiredState, name: string): ProxySite {
  const p = state.proxies[name];
  if (!p) throw notFoundError(`proxy site not found: ${name}`);
  return p;
}

/**
 * Automatic proxy teardown is an explicit non-goal (product §8 / Phase G).
 */
export function deleteProxy(_state: DesiredState, _name: string): never {
  throw safetyError(
    "automatic proxy teardown is unsupported",
    "Proxy site deletion is outside the product contract. Adjust routing manually only with an operator-owned procedure outside Bento if required.",
  );
}

export function setProxyTls(
  state: DesiredState,
  name: string,
  tls: TlsMode,
  now: string,
): DesiredState {
  const proxy = getProxyOrThrow(state, name);
  return {
    ...state,
    proxies: {
      ...state.proxies,
      [name]: { ...proxy, tls, updatedAt: now },
    },
    updatedAt: now,
  };
}
