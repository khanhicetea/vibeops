/**
 * Phase D — distribution parity (F-28 / F-29 / F-30).
 *
 * - Source mode always exercises asset digest + digest-addressed materialize cache.
 * - When BENTO_BIN (or dist/bento) is available, smoke-test the compiled artifact and
 *   compare generated managed files against source mode for identical inputs.
 *
 * Set REQUIRE_BENTO_BIN=1 to fail when no binary is present (used by `deno task test:parity`).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { runCli } from "../../src/main.ts";
import { createPlatform } from "../../src/platform/mod.ts";
import {
  isParityManagedPath,
  materializeDockerAssets,
  normalizeParityText,
} from "../../src/services/assets_materialize.ts";
import { BENTO_VERSION, DENO_TARGET_VERSION, versionBanner } from "../../src/version.ts";

async function withStack(fn: (stack: string) => Promise<void>) {
  const stack = await Deno.makeTempDir({ prefix: "bento-parity-" });
  try {
    await fn(stack);
  } finally {
    await Deno.remove(stack, { recursive: true });
  }
}

async function resolveBentoBin(): Promise<string | null> {
  const envBin = Deno.env.get("BENTO_BIN");
  if (envBin && envBin.length > 0) {
    try {
      const st = await Deno.stat(envBin);
      if (st.isFile) return resolve(envBin);
    } catch {
      // fall through
    }
  }
  const dist = resolve("dist/bento");
  try {
    const st = await Deno.stat(dist);
    if (st.isFile) return dist;
  } catch {
    // missing
  }
  return null;
}

async function runBin(
  bin: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(bin, {
    args,
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function collectFiles(root: string, base = ""): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  async function walk(dir: string, rel: string) {
    let names: string[];
    try {
      names = [];
      for await (const e of Deno.readDir(dir)) names.push(e.name);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = await Deno.lstat(full);
      if (st.isDirectory) {
        // Skip volatile transaction dirs; walk other trees (including .asset-cache filter below).
        if (name === ".staging" || name === ".transaction-backup") continue;
        await walk(full, childRel);
      } else if (st.isFile) {
        if (!isParityManagedPath(childRel)) continue;
        // skip cache-only and cert material that is intentionally non-deterministic
        if (childRel.startsWith(".asset-cache/")) continue;
        if (childRel.startsWith("certs/")) continue;
        if (childRel.endsWith(".materialized.json")) continue;
        if (childRel.endsWith(".generation.json")) continue;
        const bytes = await Deno.readFile(full);
        // text compare for config; binary would be hex
        try {
          map.set(childRel, normalizeParityText(new TextDecoder().decode(bytes)));
        } catch {
          map.set(childRel, `binary:${bytes.length}`);
        }
      }
    }
  }
  await walk(root, base);
  return map;
}

Deno.test("version banner reports bento and pinned deno target", () => {
  const banner = versionBanner();
  assertEquals(banner.includes(BENTO_VERSION), true);
  assertEquals(banner.includes(DENO_TARGET_VERSION), true);
  assertEquals(banner, `bento ${BENTO_VERSION} (deno ${DENO_TARGET_VERSION})`);
});

Deno.test("asset digest is stable across resolver instances", async () => {
  const a = createPlatform(await Deno.makeTempDir(), Deno.cwd());
  const b = createPlatform(await Deno.makeTempDir(), Deno.cwd());
  const da = await a.assets.digest();
  const db = await b.assets.digest();
  assertEquals(da, db);
  assertEquals(da.length, 64);
});

Deno.test("materialize uses digest-addressed cache and skips republish", async () => {
  await withStack(async (stack) => {
    const platform = createPlatform(stack, Deno.cwd());
    const first = await materializeDockerAssets(platform, ["8.5"]);
    assertEquals(first.digest.length, 64);
    assertEquals(first.published, true);
    assertEquals(await Deno.stat(join(first.cacheDir, ".ready")).then(() => true), true);
    assertEquals(
      await Deno.stat(join(stack, "docker/nginx/Dockerfile")).then(() => true),
      true,
    );
    assertEquals(
      await Deno.stat(join(stack, "helpers/deploy-webhook.php")).then(() => true),
      true,
    );

    const meta1 = await Deno.readTextFile(join(stack, "docker/.materialized.json"));
    assertEquals(JSON.parse(meta1).digest, first.digest);
    assertEquals(JSON.parse(meta1).cacheDir, `.asset-cache/${first.digest}`);

    const second = await materializeDockerAssets(platform, ["8.5"]);
    assertEquals(second.digest, first.digest);
    assertEquals(second.cacheDir, first.cacheDir);
    assertEquals(second.published, false);

    // Cache entry remains the single source of truth
    const cacheDocker = join(first.cacheDir, "docker/nginx/Dockerfile");
    const pubDocker = join(stack, "docker/nginx/Dockerfile");
    assertEquals(await Deno.readTextFile(cacheDocker), await Deno.readTextFile(pubDocker));
  });
});

Deno.test("source init/render/status smoke (F-28)", async () => {
  await withStack(async (stack) => {
    const base = ["--stack", stack, "--repo-root", Deno.cwd()];
    assertEquals(await runCli([...base, "init"]), 0);
    assertEquals(await runCli([...base, "render"]), 0);
    assertEquals(await runCli([...base, "status"]), 0);
    assertEquals(await runCli([...base, "version"]), 0);

    // digest-addressed cache present after render
    const meta = JSON.parse(
      await Deno.readTextFile(join(stack, "docker/.materialized.json")),
    );
    assertEquals(typeof meta.digest, "string");
    assertEquals(
      await Deno.stat(join(stack, ".asset-cache", meta.digest, ".ready")).then(() => true),
      true,
    );
  });
});

Deno.test({
  name: "compiled binary smoke + source/compiled parity (F-29 / F-30)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const bin = await resolveBentoBin();
    if (!bin) {
      if (Deno.env.get("REQUIRE_BENTO_BIN") === "1") {
        throw new Error(
          "BENTO_BIN not set and dist/bento missing; run `deno task compile` or `deno task test:parity`",
        );
      }
      console.log(
        "skip compiled parity: no BENTO_BIN / dist/bento (set REQUIRE_BENTO_BIN=1 to require)",
      );
      return;
    }

    // F-29: version / init / render / status without needing Deno on PATH
    {
      const ver = await runBin(bin, ["version"], {
        cwd: "/tmp",
        env: { PATH: "/usr/bin:/bin", HOME: Deno.env.get("HOME") ?? "/tmp" },
      });
      assertEquals(ver.code, 0, ver.stderr);
      assertEquals(ver.stdout.includes(BENTO_VERSION), true);
      assertEquals(ver.stdout.includes(DENO_TARGET_VERSION), true);
    }

    await withStack(async (baseStack) => {
      // Shared inputs: init once via source, clone to two stacks
      const seed = ["--stack", baseStack, "--repo-root", Deno.cwd()];
      assertEquals(await runCli([...seed, "init"]), 0);
      // Create an app so generated surface is non-trivial
      assertEquals(
        await runCli([
          ...seed,
          "app",
          "create",
          "parity",
          "--domain",
          "parity.test",
          "--no-apply",
        ]),
        0,
      );

      const srcStack = await Deno.makeTempDir({ prefix: "bento-parity-src-" });
      const binStack = await Deno.makeTempDir({ prefix: "bento-parity-bin-" });
      try {
        await copyDir(baseStack, srcStack);
        await copyDir(baseStack, binStack);
        // Drop any generated output so both modes re-render cleanly
        for (const s of [srcStack, binStack]) {
          await Deno.remove(join(s, "generated"), { recursive: true }).catch(() => {});
          await Deno.remove(join(s, "docker"), { recursive: true }).catch(() => {});
          await Deno.remove(join(s, "helpers"), { recursive: true }).catch(() => {});
          await Deno.remove(join(s, ".asset-cache"), { recursive: true }).catch(() => {});
        }

        const srcCode = await runCli([
          "--stack",
          srcStack,
          "--repo-root",
          Deno.cwd(),
          "render",
        ]);
        const binRender = await runBin(bin, ["--stack", binStack, "render"], {
          cwd: "/tmp",
          env: { PATH: "/usr/bin:/bin", HOME: Deno.env.get("HOME") ?? "/tmp" },
        });
        assertEquals(srcCode, 0);
        assertEquals(binRender.code, 0, binRender.stderr + binRender.stdout);

        const srcStatus = await runCli([
          "--stack",
          srcStack,
          "--repo-root",
          Deno.cwd(),
          "status",
        ]);
        const binStatus = await runBin(bin, ["--stack", binStack, "status"], {
          cwd: "/tmp",
          env: { PATH: "/usr/bin:/bin", HOME: Deno.env.get("HOME") ?? "/tmp" },
        });
        assertEquals(srcStatus, 0);
        assertEquals(binStatus.code, 0, binStatus.stderr);

        // State transitions equal
        const srcState = await Deno.readTextFile(join(srcStack, "state.json"));
        const binState = await Deno.readTextFile(join(binStack, "state.json"));
        assertEquals(normalizeParityText(srcState), normalizeParityText(binState));

        // Asset digests equal
        const srcMeta = JSON.parse(
          await Deno.readTextFile(join(srcStack, "docker/.materialized.json")),
        );
        const binMeta = JSON.parse(
          await Deno.readTextFile(join(binStack, "docker/.materialized.json")),
        );
        assertEquals(srcMeta.digest, binMeta.digest);

        // Generated managed files byte-equivalent (normalized)
        const srcFiles = await collectFiles(join(srcStack, "generated"));
        const binFiles = await collectFiles(join(binStack, "generated"));
        assertEquals([...srcFiles.keys()].sort(), [...binFiles.keys()].sort());
        for (const [rel, content] of srcFiles) {
          assertEquals(binFiles.get(rel), content, `mismatch in generated/${rel}`);
        }

        // Docker + helpers published assets equal
        const srcDocker = await collectFiles(join(srcStack, "docker"));
        const binDocker = await collectFiles(join(binStack, "docker"));
        assertEquals([...srcDocker.keys()].sort(), [...binDocker.keys()].sort());
        for (const [rel, content] of srcDocker) {
          assertEquals(binDocker.get(rel), content, `mismatch in docker/${rel}`);
        }
        const srcHelpers = await collectFiles(join(srcStack, "helpers"));
        const binHelpers = await collectFiles(join(binStack, "helpers"));
        assertEquals([...srcHelpers.keys()].sort(), [...binHelpers.keys()].sort());
        for (const [rel, content] of srcHelpers) {
          assertEquals(binHelpers.get(rel), content, `mismatch in helpers/${rel}`);
        }

        // Normalized status diagnostics: same structure (strip stack path)
        // (status is printed by runCli to the process stdout; we re-run via bin capture)
        assertNotEquals(binStatus.stdout.length, 0);
        assertEquals(binStatus.stdout.includes("parity"), true);
        assertEquals(binStatus.stdout.includes(binStack), true);
      } finally {
        await Deno.remove(srcStack, { recursive: true }).catch(() => {});
        await Deno.remove(binStack, { recursive: true }).catch(() => {});
      }
    });
  },
});

async function copyDir(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) {
      await copyDir(src, dest);
    } else if (entry.isFile) {
      await Deno.copyFile(src, dest);
    }
  }
}
