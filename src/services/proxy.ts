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
  upstream: string;
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
  if (!input.upstream || !/^https?:\/\//.test(input.upstream)) {
    throw validationError("upstream must be an http(s) URL reachable from the host");
  }

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
    upstream: input.upstream,
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
