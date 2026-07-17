/**
 * TLS mode helpers: boot / ACME / external certificate paths and validation.
 *
 * Modes:
 * - boot: self-signed starter cert under stack certs/ (generated on materialize + nginx entrypoint)
 * - acme: operator-issued certs under certs/acme/<domain>/; HTTP-01 challenge webroot at certs/acme-www
 * - external: operator-managed cert/key files under stack certs/ (never world-readable keys)
 *
 * HTTPS redirect is enabled only when mode !== boot (real certificate mode).
 */

import { isAbsolute, join, relative, resolve } from "@std/path";
import type { TlsMode } from "../domain/state.ts";
import { validationError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";

/** Container path for ACME HTTP-01 challenge tokens. */
export const ACME_CHALLENGE_ROOT = "/var/www/acme";

/** Host-relative webroot under the stack root for ACME challenges. */
export const ACME_CHALLENGE_HOST_REL = "certs/acme-www";

export type ResolvedSsl = {
  /** nginx include path inside the container (absolute). */
  includePath: string;
  /** Generated snippet content (when managed per-site). */
  snippetRelPath?: string;
  snippetContent?: string;
  /** Whether HTTP→HTTPS redirect should be active. */
  redirectHttps: boolean;
  /** Whether to expose ACME challenge location on :80. */
  acmeChallenge: boolean;
  /** Operator-facing notes (DNS, issuance). */
  notes: string[];
};

/**
 * Resolve SSL include + snippet generation for a site (app slug or proxy name).
 * `mainDomain` is used for ACME path layout.
 */
export function resolveSslForSite(
  tls: TlsMode,
  siteId: string,
  mainDomain: string,
): ResolvedSsl {
  if (tls.kind === "boot") {
    return {
      includePath: "/etc/nginx/snippets/boot-ssl.conf",
      redirectHttps: false,
      acmeChallenge: false,
      notes: [
        "Boot TLS uses a self-signed certificate so HTTPS can start before production certs exist.",
      ],
    };
  }

  if (tls.kind === "acme") {
    const snippetRelPath = `nginx/snippets/ssl-${siteId}.conf`;
    const cert = `/etc/nginx/certs/acme/${mainDomain}/fullchain.pem`;
    const key = `/etc/nginx/certs/acme/${mainDomain}/privkey.pem`;
    return {
      includePath: `/etc/nginx/snippets/ssl-${siteId}.conf`,
      snippetRelPath,
      snippetContent: renderSslSnippet(cert, key),
      redirectHttps: true,
      acmeChallenge: true,
      notes: [
        `Point DNS A/AAAA for ${mainDomain} (and aliases) to this host before issuance.`,
        `Issue certs into stack certs/acme/${mainDomain}/ (fullchain.pem + privkey.pem).`,
        `HTTP-01 webroot is ${ACME_CHALLENGE_HOST_REL} (container ${ACME_CHALLENGE_ROOT}).`,
        "Example: certbot certonly --webroot -w ./certs/acme-www -d " + mainDomain,
        tls.email
          ? `ACME contact email recorded: ${tls.email}`
          : "Optional: set ACME email via `tls set --mode acme --email you@example.com`.",
      ],
    };
  }

  // external
  const snippetRelPath = `nginx/snippets/ssl-${siteId}.conf`;
  // Container paths: external files must live under stack certs/ and map 1:1.
  const certContainer = containerCertPath(tls.certPath);
  const keyContainer = containerCertPath(tls.keyPath);
  return {
    includePath: `/etc/nginx/snippets/ssl-${siteId}.conf`,
    snippetRelPath,
    snippetContent: renderSslSnippet(certContainer, keyContainer),
    redirectHttps: true,
    acmeChallenge: false,
    notes: [
      "External TLS uses operator-managed certificate files under the stack certs/ directory.",
      "Private keys must not be world-readable (mode 0600 recommended).",
    ],
  };
}

function renderSslSnippet(cert: string, key: string): string {
  return `ssl_certificate     ${cert};
ssl_certificate_key ${key};
ssl_protocols       TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
`;
}

/**
 * Map a host path (absolute or relative to stack certs/) to the container certs mount.
 * External certs must resolve under /etc/nginx/certs/.
 */
export function containerCertPath(hostOrRel: string): string {
  const normalized = hostOrRel.replace(/\\/g, "/");
  if (normalized.startsWith("/etc/nginx/certs/")) return normalized;
  // Relative path under certs/
  if (!isAbsolute(normalized) || normalized.startsWith("certs/")) {
    const rel = normalized.replace(/^certs\//, "").replace(/^\//, "");
    return `/etc/nginx/certs/${rel}`;
  }
  // Absolute host path — take trailing segment after /certs/ if present
  const idx = normalized.lastIndexOf("/certs/");
  if (idx >= 0) {
    return `/etc/nginx/certs/${normalized.slice(idx + "/certs/".length)}`;
  }
  // Fall back: basename under certs/external/
  const base = normalized.split("/").filter(Boolean).pop() ?? "cert.pem";
  return `/etc/nginx/certs/external/${base}`;
}

/**
 * Validate external TLS paths on the host before recording state.
 * Ensures cert/key exist, key is not world-readable, and paths stay under stack certs/.
 */
export async function validateExternalTlsPaths(
  platform: Platform,
  certPath: string,
  keyPath: string,
): Promise<void> {
  const certsDir = resolve(platform.paths.paths.certsDir);
  const resolveUnderCerts = (p: string): string => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(certsDir, p);
    const rel = relative(certsDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw validationError(
        `TLS path must be under stack certs directory (${certsDir}): ${p}`,
        {
          recovery:
            "Place certificate files under the stack certs/ directory and pass paths relative to it, or absolute paths under that tree.",
        },
      );
    }
    return abs;
  };

  const certAbs = resolveUnderCerts(certPath);
  const keyAbs = resolveUnderCerts(keyPath);

  if (!(await platform.fs.exists(certAbs))) {
    throw validationError(`TLS certificate not found: ${certAbs}`, {
      recovery: "Create the certificate file before switching to external TLS mode.",
    });
  }
  if (!(await platform.fs.exists(keyAbs))) {
    throw validationError(`TLS private key not found: ${keyAbs}`, {
      recovery: "Create the private key file before switching to external TLS mode.",
    });
  }

  try {
    const st = await platform.fs.stat(keyAbs);
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw validationError(
        `TLS private key is group/world accessible (mode ${mode.toString(8)}): ${keyAbs}`,
        {
          recovery: "chmod 600 the private key so only the owner can read it.",
        },
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("group/world")) throw e;
    throw validationError(
      `unable to stat TLS private key: ${keyAbs}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Ensure ACME webroot directory exists on the host (challenge tokens). */
export async function ensureAcmeWebroot(platform: Platform): Promise<string> {
  const dir = join(platform.paths.paths.root, ACME_CHALLENGE_HOST_REL);
  await platform.fs.mkdirp(dir, 0o755);
  return dir;
}

/** Operator documentation for TLS modes (CLI / README snippets). */
export function tlsOperatorDocs(): string {
  return [
    "TLS modes:",
    "  boot     Self-signed starter cert (default). No HTTP→HTTPS redirect.",
    "  acme     Real certs under certs/acme/<domain>/; HTTP-01 at certs/acme-www.",
    "           DNS A/AAAA for the site must point at this host before issuance.",
    "           Example: certbot certonly --webroot -w ./certs/acme-www -d example.com",
    "  external Operator-managed cert+key under stack certs/ (key mode 0600).",
    "HTTPS redirect is enabled only for acme and external modes.",
  ].join("\n");
}

/** Nginx location block for ACME HTTP-01 (inserted on :80 when acmeChallenge). */
export function acmeChallengeLocationBlock(): string {
  return `  location ^~ /.well-known/acme-challenge/ {
    root ${ACME_CHALLENGE_ROOT};
    default_type "text/plain";
    allow all;
  }
`;
}
