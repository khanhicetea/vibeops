/**
 * Materialize immutable docker/build assets into the stack so Compose can build.
 * Source mode copies from templates/; compiled mode uses the same asset resolver.
 *
 * Assets are staged into a digest-addressed cache under stack/.asset-cache/<digest>/
 * then published to the stable Compose-relative paths (docker/, helpers/).
 */

import { dirname, join } from "@std/path";
import type { Platform } from "../platform/mod.ts";
import { encodeHex } from "@std/encoding/hex";

export type MaterializeResult = {
  dockerRoot: string;
  nginxContext: string;
  phpContext: string;
  helpersDir: string;
  digest: string;
  /** Absolute path to the digest-addressed cache entry used. */
  cacheDir: string;
  /** Whether content was (re)published to stack docker/helpers this call. */
  published: boolean;
};

const DOCKER_NGINX_FILES = [
  "docker/nginx/Dockerfile",
  "docker/nginx/snippets/app-common.conf",
  "docker/nginx/snippets/boot-ssl.conf",
  "docker/nginx/docker-entrypoint.d/10-bento-boot-cert.sh",
] as const;

const DOCKER_PHP_FILES = [
  "docker/php/Dockerfile",
  "docker/php/conf/php-bento.ini",
  "docker/php/conf/opcache.ini",
  "docker/php/conf/www-docker.conf",
  "docker/php/entrypoint.sh",
  "docker/php/runner-entrypoint.sh",
  "docker/php/helpers/deploy-drain.sh",
] as const;

const HELPER_FILES = [
  "helpers/deploy-webhook.php",
  "helpers/clean-opcache.php",
  "helpers/deploy-drain.sh",
] as const;

/**
 * Materialize docker contexts + helpers under stack/docker and stack/helpers
 * for stable compose-relative paths, via a digest-addressed cache.
 */
export async function materializeDockerAssets(
  platform: Platform,
  phpVersions: string[],
): Promise<MaterializeResult> {
  const digest = await platform.assets.digest();
  const cacheDir = join(platform.paths.paths.assetCacheDir, digest);
  const dockerRoot = join(platform.paths.paths.root, "docker");
  const helpersDir = join(platform.paths.paths.root, "helpers");
  const nginxContext = join(dockerRoot, "nginx");
  const phpContext = join(dockerRoot, "php");

  await platform.fs.mkdirp(platform.paths.paths.assetCacheDir);

  // Build digest-addressed cache entry if missing (atomic partial -> ready).
  if (!(await platform.fs.exists(join(cacheDir, ".ready")))) {
    await buildDigestCache(platform, cacheDir, digest);
  }

  let published = false;
  if (!(await isPublishedCurrent(platform, dockerRoot, helpersDir, digest))) {
    await publishFromCache(platform, cacheDir, dockerRoot, helpersDir);
    // Mirror stack helpers into PHP build context (Compose COPY helpers/)
    for (const name of ["deploy-webhook.php", "clean-opcache.php", "deploy-drain.sh"]) {
      const src = join(helpersDir, name);
      if (await platform.fs.exists(src)) {
        const dest = join(phpContext, "helpers", name);
        await platform.fs.mkdirp(dirname(dest));
        await platform.fs.copyFile(src, dest);
        if (name.endsWith(".sh")) {
          try {
            await platform.fs.chmod(dest, 0o755);
          } catch {
            // ignore
          }
        }
      }
    }
    await platform.fs.atomicWriteText(
      join(dockerRoot, ".materialized.json"),
      `${
        JSON.stringify(
          {
            digest,
            phpVersions,
            at: platform.clock.nowIso(),
            cacheDir: ".asset-cache/" + digest,
          },
          null,
          2,
        )
      }\n`,
    );
    published = true;
  }

  // Runtime dirs Compose mounts (not part of immutable asset digest)
  await platform.fs.mkdirp(join(platform.paths.paths.root, "runtime", "php-fpm"));
  await platform.fs.mkdirp(join(platform.paths.paths.root, "logs", "nginx"));
  await platform.fs.mkdirp(platform.paths.paths.certsDir);
  for (const v of phpVersions) {
    const svc = `php${v.replace(".", "")}`;
    await platform.fs.mkdirp(join(platform.paths.paths.root, "runtime", "php-fpm", svc));
    await platform.fs.mkdirp(join(platform.paths.paths.root, "runtime", "locks", svc));
  }

  await ensureBootCert(platform);
  // ACME HTTP-01 webroot (used when any site is in acme mode; safe empty dir otherwise).
  await platform.fs.mkdirp(join(platform.paths.paths.certsDir, "acme-www"), 0o755);

  return {
    dockerRoot,
    nginxContext,
    phpContext,
    helpersDir,
    digest,
    cacheDir,
    published,
  };
}

async function buildDigestCache(
  platform: Platform,
  cacheDir: string,
  digest: string,
): Promise<void> {
  const partial = `${cacheDir}.partial`;
  await platform.fs.remove(partial, { recursive: true });
  await platform.fs.mkdirp(partial);

  const dockerRoot = join(partial, "docker");
  const helpersRoot = join(partial, "helpers");
  await platform.fs.mkdirp(dockerRoot);
  await platform.fs.mkdirp(helpersRoot);

  await materializePaths(platform, [...DOCKER_NGINX_FILES], dockerRoot, "docker/");
  await materializePaths(platform, [...DOCKER_PHP_FILES], dockerRoot, "docker/");
  // helpers/ listed as helpers/... under templates
  await materializePaths(platform, [...HELPER_FILES], partial, "");

  // Also stage helpers into php build context inside the cache for completeness
  for (const name of ["deploy-webhook.php", "clean-opcache.php", "deploy-drain.sh"]) {
    const src = join(helpersRoot, name);
    if (await platform.fs.exists(src)) {
      const dest = join(dockerRoot, "php", "helpers", name);
      await platform.fs.mkdirp(dirname(dest));
      await platform.fs.copyFile(src, dest);
      if (name.endsWith(".sh")) {
        try {
          await platform.fs.chmod(dest, 0o755);
        } catch {
          // ignore
        }
      }
    }
  }

  await platform.fs.atomicWriteText(
    join(partial, ".ready"),
    `${JSON.stringify({ digest, ready: true }, null, 2)}\n`,
  );

  // Atomic promote: replace any incomplete cache entry
  if (await platform.fs.exists(cacheDir)) {
    await platform.fs.remove(cacheDir, { recursive: true });
  }
  try {
    await platform.fs.rename(partial, cacheDir);
  } catch {
    // Another writer may have won the race; accept existing ready cache.
    await platform.fs.remove(partial, { recursive: true });
    if (!(await platform.fs.exists(join(cacheDir, ".ready")))) {
      throw new Error(`failed to promote asset cache for digest ${digest}`);
    }
  }
}

async function isPublishedCurrent(
  platform: Platform,
  dockerRoot: string,
  helpersDir: string,
  digest: string,
): Promise<boolean> {
  const metaPath = join(dockerRoot, ".materialized.json");
  if (!(await platform.fs.exists(metaPath))) return false;
  if (!(await platform.fs.exists(join(dockerRoot, "nginx")))) return false;
  if (!(await platform.fs.exists(helpersDir))) return false;
  try {
    const meta = JSON.parse(await platform.fs.readText(metaPath)) as { digest?: string };
    return meta.digest === digest;
  } catch {
    return false;
  }
}

async function publishFromCache(
  platform: Platform,
  cacheDir: string,
  dockerRoot: string,
  helpersDir: string,
): Promise<void> {
  await copyTree(platform, join(cacheDir, "docker"), dockerRoot);
  await copyTree(platform, join(cacheDir, "helpers"), helpersDir);
}

async function copyTree(
  platform: Platform,
  fromDir: string,
  toDir: string,
): Promise<void> {
  if (!(await platform.fs.exists(fromDir))) {
    await platform.fs.mkdirp(toDir);
    return;
  }
  await platform.fs.mkdirp(toDir);
  async function walk(rel: string) {
    const src = rel ? join(fromDir, rel) : fromDir;
    const names = await platform.fs.readDir(src);
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const full = join(fromDir, childRel);
      const st = await platform.fs.stat(full);
      if (st.isDirectory) {
        await platform.fs.mkdirp(join(toDir, childRel));
        await walk(childRel);
      } else if (st.isFile) {
        const dest = join(toDir, childRel);
        await platform.fs.mkdirp(dirname(dest));
        await platform.fs.copyFile(full, dest);
        if (dest.endsWith(".sh")) {
          try {
            await platform.fs.chmod(dest, 0o755);
          } catch {
            // ignore
          }
        }
      }
    }
  }
  await walk("");
}

async function materializePaths(
  platform: Platform,
  paths: string[],
  destRoot: string,
  stripPrefix: string,
): Promise<void> {
  for (const p of paths) {
    try {
      const bytes = await platform.assets.readBytes(p);
      const rel = stripPrefix && p.startsWith(stripPrefix) ? p.slice(stripPrefix.length) : p;
      const dest = join(destRoot, rel);
      await platform.fs.mkdirp(dirname(dest));
      await platform.fs.writeBytes(dest, bytes);
      if (dest.endsWith(".sh")) {
        try {
          await platform.fs.chmod(dest, 0o755);
        } catch {
          // ignore
        }
      }
    } catch {
      // skip missing optional assets
    }
  }
}

async function ensureBootCert(platform: Platform): Promise<void> {
  const certDir = platform.paths.paths.certsDir;
  const crt = join(certDir, "boot.crt");
  const key = join(certDir, "boot.key");
  if (await platform.fs.exists(crt) && await platform.fs.exists(key)) return;

  const result = await platform.process.run([
    "openssl",
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-keyout",
    key,
    "-out",
    crt,
    "-days",
    "825",
    "-subj",
    "/CN=bento-boot/O=Bento/C=US",
  ], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "", stderr: "openssl missing" }));

  if (result.code !== 0) {
    await platform.fs.atomicWriteText(
      join(certDir, "README.txt"),
      "Boot TLS certificate missing. Install openssl or place boot.crt/boot.key here.\n",
    );
  } else {
    try {
      await platform.fs.chmod(key, 0o600);
    } catch {
      // ignore
    }
  }
}

export async function assetContentDigest(
  platform: Platform,
  paths: string[],
): Promise<string> {
  const chunks: string[] = [];
  for (const p of [...paths].sort()) {
    try {
      const bytes = await platform.assets.readBytes(p);
      const hash = await crypto.subtle.digest("SHA-256", bytes.slice());
      chunks.push(`${p}:${encodeHex(new Uint8Array(hash))}`);
    } catch {
      chunks.push(`${p}:missing`);
    }
  }
  const combined = new TextEncoder().encode(chunks.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", combined.slice());
  return encodeHex(new Uint8Array(digest));
}

/** Paths compared for source/compiled generated-file parity (exclude volatile metadata). */
export function isParityManagedPath(relPath: string): boolean {
  if (relPath === ".generation.json") return false;
  if (relPath.endsWith("/.generation.json")) return false;
  if (relPath.includes(".render-journal")) return false;
  if (relPath.includes(".staging")) return false;
  if (relPath.includes(".transaction-backup")) return false;
  return true;
}

/**
 * Normalize diagnostics / metadata text for source vs compiled comparison.
 * Strips volatile timestamps while preserving structure.
 */
export function normalizeParityText(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    .replace(/"at"\s*:\s*"<TIMESTAMP>"/g, '"at": "<TIMESTAMP>"')
    .replace(/"renderedAt"\s*:\s*"<TIMESTAMP>"/g, '"renderedAt": "<TIMESTAMP>"')
    .replace(/"startedAt"\s*:\s*"<TIMESTAMP>"/g, '"startedAt": "<TIMESTAMP>"')
    .replace(/"updatedAt"\s*:\s*"<TIMESTAMP>"/g, '"updatedAt": "<TIMESTAMP>"')
    .replace(/"createdAt"\s*:\s*"<TIMESTAMP>"/g, '"createdAt": "<TIMESTAMP>"');
}
