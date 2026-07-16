import { dirname, fromFileUrl, join, normalize } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { AssetResolver, FileSystem } from "./interfaces.ts";
import { platformError } from "../domain/errors.ts";

/**
 * Resolve immutable assets from repository (source mode) or embedded compile includes.
 * Operator state always lives under the external stack root, never next to the binary.
 */
export function createAssetResolver(fs: FileSystem, repoRoot?: string): AssetResolver {
  const root = repoRoot ?? defaultRepoRoot();

  async function resolveAsset(assetPath: string): Promise<string> {
    const clean = normalize(assetPath).replace(/^(\.\.(\/|\\|$))+/, "");
    // Prefer templates/ tree
    const candidates = [
      join(root, "templates", clean),
      join(root, clean),
    ];
    for (const c of candidates) {
      if (await fs.exists(c)) return c;
    }
    throw platformError(`asset not found: ${assetPath}`);
  }

  return {
    async readText(assetPath: string): Promise<string> {
      const path = await resolveAsset(assetPath);
      return await fs.readText(path);
    },
    async readBytes(assetPath: string): Promise<Uint8Array> {
      const path = await resolveAsset(assetPath);
      return await fs.readBytes(path);
    },
    async materialize(assetPath: string, destDir: string): Promise<string> {
      const path = await resolveAsset(assetPath);
      const dest = join(destDir, assetPath);
      await fs.mkdirp(dirname(dest));
      await fs.copyFile(path, dest);
      return dest;
    },
    async digest(): Promise<string> {
      // Stable digest of templates tree for parity tracking.
      const templatesRoot = join(root, "templates");
      const files: string[] = [];
      async function walk(dir: string, prefix: string) {
        if (!(await fs.exists(dir))) return;
        const names = await fs.readDir(dir);
        for (const name of names) {
          const full = join(dir, name);
          const rel = prefix ? `${prefix}/${name}` : name;
          const st = await fs.stat(full);
          if (st.isDirectory) await walk(full, rel);
          else if (st.isFile) files.push(rel);
        }
      }
      await walk(templatesRoot, "");
      files.sort();
      const chunks: string[] = [];
      for (const rel of files) {
        const bytes = await fs.readBytes(join(templatesRoot, rel));
        const hash = await crypto.subtle.digest("SHA-256", bytes.slice());
        chunks.push(`${rel}:${encodeHex(new Uint8Array(hash))}`);
      }
      const combined = new TextEncoder().encode(chunks.join("\n"));
      const digest = await crypto.subtle.digest("SHA-256", combined.slice());
      return encodeHex(new Uint8Array(digest));
    },
  };
}

function defaultRepoRoot(): string {
  // src/platform/assets.ts -> repo root
  try {
    const here = dirname(fromFileUrl(import.meta.url));
    return join(here, "..", "..");
  } catch {
    return Deno.cwd();
  }
}
