/**
 * TLS mode helpers: private CA, shared self-signed, ACME, and external files.
 *
 * The private CA key never leaves certs/private-ca/ca.key. Per-site leaf certificates
 * include the primary domain and aliases as SANs and are renewed during apply.
 */

import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import type { DesiredState, TlsMode } from "../domain/state.ts";
import { validationError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";

export const DEFAULT_ACME_URL = "https://acme-v02.api.letsencrypt.org/directory";
export const ACME_ISSUER = "bento_acme";
export const ACME_STATE_ROOT = "/var/cache/nginx/acme";

function nginxQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}"`;
}

/** Render the single native Nginx ACME issuer shared by all ACME sites. */
export function renderAcmeIssuer(url: string, email?: string): string {
  const contact = email ? `  contact ${nginxQuoted(email)};\n` : "";
  return `acme_issuer ${ACME_ISSUER} {
  uri ${nginxQuoted(url)};
${contact}  state_path ${ACME_STATE_ROOT}/${ACME_ISSUER};
  accept_terms_of_service;
}`;
}

export type ResolvedSsl = {
  /** nginx include path inside the container (absolute). */
  includePath: string;
  /** Certificate directives rendered directly into the vhost when present. */
  certificatePath?: string;
  certificateKeyPath?: string;
  /** Generated snippet content (when managed per-site). */
  snippetRelPath?: string;
  snippetContent?: string;
  /** Whether HTTP→HTTPS redirect should be active. */
  redirectHttps: boolean;
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
  if (tls.kind === "shared") {
    return {
      includePath: "/etc/nginx/snippets/boot-ssl.conf",
      redirectHttps: false,
      notes: [
        "Shared TLS uses one self-signed starter certificate for every site.",
      ],
    };
  }

  if (tls.kind === "self-ca") {
    const certContainer = `/etc/nginx/certs/private-ca/sites/${siteId}.crt`;
    const keyContainer = `/etc/nginx/certs/private-ca/sites/${siteId}.key`;
    return {
      includePath: "/etc/nginx/snippets/ssl-common.conf",
      certificatePath: certContainer,
      certificateKeyPath: keyContainer,
      redirectHttps: true,
      notes: [
        `The Bento private CA signs a certificate for ${mainDomain} and its aliases.`,
        "Import certs/private-ca/ca.crt into each client or server trust store.",
      ],
    };
  }

  if (tls.kind === "acme") {
    return {
      includePath: "/etc/nginx/snippets/acme-ssl.conf",
      redirectHttps: true,
      notes: [
        `Point DNS A/AAAA for ${mainDomain} (and aliases) to this host before issuance.`,
        "Nginx will issue and renew the certificate automatically using HTTP-01.",
        "Set the shared ACME contact with ACME_EMAIL in the stack .env.",
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
    notes: [
      "External TLS uses operator-managed certificate files under the stack certs/ directory.",
      "Private keys must not be world-readable (mode 0600 recommended).",
    ],
  };
}

export function renderSslCommonSnippet(): string {
  return `ssl_protocols       TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
`;
}

export function renderAcmeSslSnippet(): string {
  return `acme_certificate ${ACME_ISSUER};
ssl_certificate     $acme_certificate;
ssl_certificate_key $acme_certificate_key;
ssl_certificate_cache max=10;
include /etc/nginx/snippets/ssl-common.conf;
`;
}

function renderSslSnippet(cert: string, key: string): string {
  return `ssl_certificate     ${cert};
ssl_certificate_key ${key};
include /etc/nginx/snippets/ssl-common.conf;
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

const PRIVATE_CA_DIR = "private-ca";
const PRIVATE_CA_CERT = "ca.crt";
const PRIVATE_CA_KEY = "ca.key";
const PRIVATE_CA_RENEW_BEFORE_SEC = 30 * 24 * 60 * 60;

function opensslFailure(action: string, stderr: string, stdout: string): Error {
  const detail = (stderr || stdout || "unknown OpenSSL error").trim();
  return validationError(`${action} failed: ${detail}`, {
    recovery: "Install OpenSSL and verify that the stack certs directory is writable.",
  });
}

async function runOpenSsl(
  platform: Platform,
  args: string[],
  action: string,
): Promise<void> {
  const result = await platform.process.run(["openssl", ...args], { timeoutMs: 30_000 });
  if (result.code !== 0) throw opensslFailure(action, result.stderr, result.stdout);
}

/** Ensure the stack private CA exists. A partial CA is rejected instead of replaced. */
export async function ensurePrivateCa(platform: Platform): Promise<string> {
  const caDir = join(platform.paths.paths.certsDir, PRIVATE_CA_DIR);
  const certPath = join(caDir, PRIVATE_CA_CERT);
  const keyPath = join(caDir, PRIVATE_CA_KEY);
  await platform.fs.mkdirp(caDir, 0o700);
  await platform.fs.chmod(caDir, 0o700);

  const hasCert = await platform.fs.exists(certPath);
  const hasKey = await platform.fs.exists(keyPath);
  if (hasCert !== hasKey) {
    throw validationError(`private CA is incomplete under ${caDir}`, {
      recovery:
        "Restore both ca.crt and ca.key from backup, or remove the incomplete CA directory to create a new CA.",
    });
  }

  if (!hasCert) {
    await runOpenSsl(platform, [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:4096",
      "-sha256",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3650",
      "-subj",
      "/CN=Bento Private CA/O=Bento",
      "-addext",
      "basicConstraints=critical,CA:TRUE,pathlen:0",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
    ], "private CA creation");
  }

  const caValid = await platform.process.run([
    "openssl",
    "x509",
    "-checkend",
    "0",
    "-noout",
    "-in",
    certPath,
  ]);
  if (caValid.code !== 0) {
    throw validationError(`private CA certificate is invalid or expired: ${certPath}`, {
      recovery:
        "Restore the CA from backup or deliberately create and redistribute a replacement CA.",
    });
  }

  const caCertPublic = await platform.process.run([
    "openssl",
    "x509",
    "-in",
    certPath,
    "-pubkey",
    "-noout",
  ]);
  const caKeyPublic = await platform.process.run([
    "openssl",
    "pkey",
    "-in",
    keyPath,
    "-pubout",
  ]);
  if (
    caCertPublic.code !== 0 || caKeyPublic.code !== 0 ||
    caCertPublic.stdout.trim() !== caKeyPublic.stdout.trim()
  ) {
    throw validationError(`private CA certificate and key do not match under ${caDir}`, {
      recovery: "Restore a matching ca.crt and ca.key pair from backup.",
    });
  }

  await platform.fs.chmod(keyPath, 0o600);
  await platform.fs.chmod(certPath, 0o644);
  return certPath;
}

async function privateCaLeafIsCurrent(
  platform: Platform,
  certPath: string,
  keyPath: string,
  metadataPath: string,
  domains: string[],
  caCertPath: string,
): Promise<boolean> {
  if (
    !(await platform.fs.exists(certPath)) || !(await platform.fs.exists(keyPath)) ||
    !(await platform.fs.exists(metadataPath))
  ) return false;
  try {
    const metadata = JSON.parse(await platform.fs.readText(metadataPath)) as {
      version?: number;
      domains?: unknown;
    };
    if (metadata.version !== 1 || JSON.stringify(metadata.domains) !== JSON.stringify(domains)) {
      return false;
    }
    const valid = await platform.process.run([
      "openssl",
      "x509",
      "-checkend",
      String(PRIVATE_CA_RENEW_BEFORE_SEC),
      "-noout",
      "-in",
      certPath,
    ]);
    if (valid.code !== 0) return false;
    const verified = await platform.process.run([
      "openssl",
      "verify",
      "-CAfile",
      caCertPath,
      certPath,
    ]);
    if (verified.code !== 0) return false;
    const certPublic = await platform.process.run([
      "openssl",
      "x509",
      "-in",
      certPath,
      "-pubkey",
      "-noout",
    ]);
    const keyPublic = await platform.process.run([
      "openssl",
      "pkey",
      "-in",
      keyPath,
      "-pubout",
    ]);
    return certPublic.code === 0 && keyPublic.code === 0 &&
      certPublic.stdout.trim() === keyPublic.stdout.trim();
  } catch {
    return false;
  }
}

/** Create or renew one CA-signed site certificate with exact DNS SAN coverage. */
export async function ensurePrivateCaSiteCertificate(
  platform: Platform,
  siteId: string,
  domainsInput: string[],
): Promise<{ certPath: string; keyPath: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(siteId)) {
    throw validationError(`invalid private CA site identifier: ${siteId}`);
  }
  const domains = [...new Set(domainsInput.map((domain) => domain.toLowerCase()))].sort();
  if (domains.length === 0) throw validationError("private CA site requires at least one domain");
  for (const domain of domains) {
    if (
      domain.length > 253 || domain.includes("..") ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    ) {
      throw validationError(`invalid DNS name for private CA certificate: ${domain}`);
    }
  }
  const caCertPath = await ensurePrivateCa(platform);
  const caDir = dirname(caCertPath);
  const caKeyPath = join(caDir, PRIVATE_CA_KEY);
  const sitesDir = join(caDir, "sites");
  await platform.fs.mkdirp(sitesDir, 0o700);
  await platform.fs.chmod(sitesDir, 0o700);

  const certPath = join(sitesDir, `${siteId}.crt`);
  const keyPath = join(sitesDir, `${siteId}.key`);
  const certTempPath = join(sitesDir, `${siteId}.crt.tmp`);
  const keyTempPath = join(sitesDir, `${siteId}.key.tmp`);
  const csrPath = join(sitesDir, `${siteId}.csr.tmp`);
  const extensionsPath = join(sitesDir, `${siteId}.ext.tmp`);
  const metadataPath = join(sitesDir, `${siteId}.json`);
  if (
    await privateCaLeafIsCurrent(
      platform,
      certPath,
      keyPath,
      metadataPath,
      domains,
      caCertPath,
    )
  ) {
    await platform.fs.chmod(keyPath, 0o600);
    return { certPath, keyPath };
  }

  const san = domains.map((domain) => `DNS:${domain}`).join(",");
  await platform.fs.atomicWriteText(
    extensionsPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${san}`,
      "",
    ].join("\n"),
    0o600,
  );

  try {
    await runOpenSsl(platform, [
      "req",
      "-new",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-keyout",
      keyTempPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${domains[0]}`,
    ], `private CA key/CSR creation for ${siteId}`);
    await platform.fs.chmod(keyTempPath, 0o600);
    await runOpenSsl(platform, [
      "x509",
      "-req",
      "-sha256",
      "-in",
      csrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      certTempPath,
      "-days",
      "825",
      "-extfile",
      extensionsPath,
    ], `private CA certificate signing for ${siteId}`);
    await platform.fs.atomicWriteBytes(
      keyPath,
      await platform.fs.readBytes(keyTempPath),
      0o600,
    );
    await platform.fs.atomicWriteBytes(
      certPath,
      await platform.fs.readBytes(certTempPath),
      0o644,
    );
    await platform.fs.atomicWriteText(
      metadataPath,
      `${JSON.stringify({ version: 1, domains }, null, 2)}\n`,
      0o600,
    );
  } finally {
    await platform.fs.remove(certTempPath).catch(() => {});
    await platform.fs.remove(keyTempPath).catch(() => {});
    await platform.fs.remove(csrPath).catch(() => {});
    await platform.fs.remove(extensionsPath).catch(() => {});
  }

  return { certPath, keyPath };
}

/** Reconcile every site using the managed private CA before Nginx config promotion. */
export async function ensureManagedTlsCertificates(
  platform: Platform,
  state: DesiredState,
): Promise<void> {
  for (const app of Object.values(state.apps)) {
    if (app.tls.kind === "self-ca") {
      await ensurePrivateCaSiteCertificate(
        platform,
        String(app.slug),
        [String(app.mainDomain), ...app.aliases.map(String)],
      );
    }
  }
  for (const proxy of Object.values(state.proxies)) {
    if (proxy.tls.kind === "self-ca") {
      await ensurePrivateCaSiteCertificate(
        platform,
        `proxy-${proxy.name}`,
        [String(proxy.mainDomain), ...proxy.aliases.map(String)],
      );
    }
  }
}

/** Copy only the public CA certificate for installation in another trust store. */
export async function exportPrivateCaCertificate(
  platform: Platform,
  outputPath: string,
  force = false,
): Promise<string> {
  const source = await ensurePrivateCa(platform);
  const destination = resolve(outputPath);
  const managedCaDir = dirname(resolve(source));
  const managedRelative = relative(managedCaDir, destination);
  if (!managedRelative.startsWith("..") && !isAbsolute(managedRelative)) {
    throw validationError(
      "CA export destination must be outside the managed private CA directory",
      {
        recovery: "Choose a separate destination such as ./bento-ca.crt.",
      },
    );
  }
  if (await platform.fs.exists(destination) && !force) {
    throw validationError(`CA export destination already exists: ${destination}`, {
      recovery: "Choose another path or pass --force to replace it.",
    });
  }
  await platform.fs.mkdirp(dirname(destination));
  await platform.fs.copyFile(source, destination);
  await platform.fs.chmod(destination, 0o644);
  return destination;
}

/** Operator documentation for TLS modes (CLI / README snippets). */
export function tlsOperatorDocs(): string {
  return [
    "TLS modes:",
    "  self-ca  Per-site certificate signed by Bento's private CA. HTTPS redirect on.",
    "  shared   One shared self-signed starter certificate (default). No HTTPS redirect.",
    "  acme     Nginx automatically issues and renews a Let's Encrypt certificate.",
    "           DNS A/AAAA must point at this host and public port 80 must be reachable.",
    "  external Operator-managed cert+key under stack certs/ (key mode 0600).",
    "Export the public CA with: bento tls ca export --output ./bento-ca.crt",
  ].join("\n");
}
