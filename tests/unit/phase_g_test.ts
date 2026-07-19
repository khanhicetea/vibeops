/**
 * Phase G — Explicit non-goals locked as safety refusals / architectural absence.
 * Product §8: do not implement multi-host, one-container-per-app, automatic teardown,
 * volume deletion, off-host backup replication, hard-coded Git deploy, Python runtime,
 * or per-app CPU/memory quotas in shared PHP containers.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { createEmptyState } from "../../src/domain/state.ts";
import { isBentoError } from "../../src/domain/errors.ts";
import { deleteApp, provisionApp } from "../../src/services/app.ts";
import { createProxy, deleteProxy } from "../../src/services/proxy.ts";
import { removeMysqlVersion } from "../../src/services/mysql.ts";
import { assembleComposeDocuments, assertSafeComposeArgs } from "../../src/services/compose.ts";
import { deployWebhookInstructions, enableDeploy } from "../../src/services/deploy.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";

function testPlatform(root: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-17T12:00:00.000Z"),
    random: createSeededRandom("0123456789abcdef"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

function assertSafety(fn: () => unknown, messagePart: string): void {
  const err = assertThrows(fn, Error, messagePart);
  assertEquals(isBentoError(err) && err.code === "SAFETY", true);
  assertEquals(isBentoError(err) ? err.exitCode : 0, 10);
}

Deno.test("G app delete is safety-blocked (no automatic teardown)", () => {
  const state = createEmptyState();
  assertSafety(() => deleteApp(state, "demo"), "app teardown");
  // State unchanged even when slug is unknown — never mutates.
  assertEquals(Object.keys(state.apps).length, 0);
});

Deno.test("G proxy delete is safety-blocked (no automatic teardown)", () => {
  const state = createEmptyState();
  assertSafety(() => deleteProxy(state, "api"), "proxy teardown");
  assertEquals(Object.keys(state.proxies).length, 0);
});

Deno.test("G MySQL version/volume removal is safety-blocked", () => {
  const state = createEmptyState();
  assertSafety(() => removeMysqlVersion(state, "8.4"), "MySQL version removal");
  assertEquals(state.mysqlVersions.length > 0, true);
});

Deno.test("G compose refuses volume-destructive down flags", () => {
  assertSafety(() => assertSafeComposeArgs(["down", "-v"]), "volume/image destruction");
  assertSafety(
    () => assertSafeComposeArgs(["down", "--volumes"]),
    "volume/image destruction",
  );
  assertSafety(
    () => assertSafeComposeArgs(["--rmi", "all", "down"]),
    "volume/image destruction",
  );
  // Non-destructive down remains allowed.
  assertSafeComposeArgs(["down"]);
  assertSafeComposeArgs(["up", "-d"]);
});

Deno.test("G shared PHP topology — not one container per app; no per-app quotas", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-g-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    state = provisionApp(platform, state, {
      slug: "beta",
      domain: "beta.test",
    }).state;
    // Two apps share the same default PHP version service identity.
    assertEquals(state.apps["alpha"]!.phpVersion, state.apps["beta"]!.phpVersion);
    const phpVersion = state.apps["alpha"]!.phpVersion;
    const phpService = state.phpVersions.find((v) => v.version === phpVersion)?.service;
    assertEquals(typeof phpService, "string");

    const docs = assembleComposeDocuments(platform, state);
    const phpFrag = docs.find((f) => f.relPath.includes(`php-${phpService}`));
    assertEquals(!!phpFrag, true);
    const raw = phpFrag!.content;
    const yaml = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    // Shared FPM/runner/cli roles only — no per-app service keys.
    assertEquals(yaml.includes(`  ${phpService}:`), true);
    assertEquals(yaml.includes(`  ${phpService}-runner:`), true);
    assertEquals(yaml.includes(`  ${phpService}-cli:`), true);
    assertEquals(yaml.includes("  alpha:"), false);
    assertEquals(yaml.includes("  beta:"), false);
    assertEquals(yaml.includes("bento-app-alpha"), false);
    // No hard CPU/memory quotas inside shared PHP containers.
    assertEquals(/cpus?\s*:/i.test(yaml), false);
    assertEquals(/mem_limit\s*:/i.test(yaml), false);
    assertEquals(/memory\s*:/i.test(yaml), false);
    assertEquals(/deploy:\s*\n\s*resources:/i.test(yaml), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("G deploy is orchestration-only (no hard-coded Git workflow)", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-g-deploy-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    state = provisionApp(platform, state, {
      slug: "ship",
      domain: "ship.test",
    }).state;
    const enabled = enableDeploy(state, { slug: "ship" }, platform);
    const app = enabled.state.apps["ship"]!;
    const text = deployWebhookInstructions(app, app.deploy.hmacSecret ?? "secret");
    assertEquals(text.includes("/_bento/deploy"), true);
    assertEquals(text.includes("deploy.sh"), true);
    // Explicitly not a source-control checkout strategy.
    assertEquals(/git\s+clone/i.test(text), false);
    assertEquals(/git\s+pull/i.test(text), false);
    assertEquals(/checkout/i.test(text), false);
    assertEquals(/github\.com|gitlab\.com|bitbucket/i.test(text), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("G control plane has no Python runtime dependency surface", async () => {
  // deno.json imports are JS/TS-only; no python shebang/runtime in src entry.
  const main = await Deno.readTextFile(new URL("../../src/main.ts", import.meta.url));
  assertEquals(main.includes("python"), false);
  assertEquals(main.startsWith("#!") && main.includes("python"), false);
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  );
  const importBlob = JSON.stringify(denoJson.imports ?? {});
  assertEquals(/python/i.test(importBlob), false);
  const tasks = JSON.stringify(denoJson.tasks ?? {});
  assertEquals(/python3?|pip\b/i.test(tasks), false);
});

Deno.test("G backup paths stay on-host under stack backupsDir (no off-host replication API)", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-g-backup-" });
  try {
    const platform = testPlatform(root);
    // Backups are local stack paths only; no s3/rsync/remote helpers exported.
    assertEquals(platform.paths.paths.backupsDir.startsWith(root), true);
    const mysqlSrc = await Deno.readTextFile(
      new URL("../../src/services/mysql.ts", import.meta.url),
    );
    assertEquals(/s3:|aws\s+s3|rsync|rclone|off-?host.*replicat/i.test(mysqlSrc), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("G proxy create still works; delete never mutates", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-g-proxy-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const created = createProxy(state, {
      name: "edge",
      domain: "edge.test",
      upstreams: ["http://127.0.0.1:3000"],
    }, platform.clock.nowIso());
    state = created.state;
    assertEquals(!!state.proxies["edge"], true);
    assertSafety(() => deleteProxy(state, "edge"), "proxy teardown");
    assertEquals(!!state.proxies["edge"], true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
