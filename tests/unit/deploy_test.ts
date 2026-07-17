import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createEmptyState } from "../../src/domain/state.ts";
import { materializeAppHome, provisionApp } from "../../src/services/app.ts";
import {
  type DeployJob,
  disableDeploy,
  drainDeploy,
  enableDeploy,
  enqueueDeploy,
  retainJobs,
  rotateDeploySecret,
  verifyDeploySignature,
} from "../../src/services/deploy.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import { encodeHex } from "@std/encoding/hex";

function testPlatform(root: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-16T12:00:00.000Z"),
    random: createSeededRandom("aabbccddeeff0011"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

async function hmacSha256(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, body.slice());
  return encodeHex(new Uint8Array(sig));
}

Deno.test("deploy surface changes reload the required data-plane services", () => {
  const root = "/tmp/bento-deploy-reload";
  const platform = testPlatform(root);
  const provisioned = provisionApp(platform, createEmptyState(), {
    slug: "alpha",
    domain: "a.test",
  });

  const enabled = enableDeploy(provisioned.state, { slug: "alpha" }, platform);
  assertEquals(enabled.reloadPlan.nginx, true);
  assertEquals(enabled.reloadPlan.phpFpm.has("php85"), true);
  assertEquals(enabled.reloadPlan.phpRunner.has("php85-runner"), true);

  const rotated = rotateDeploySecret(enabled.state, "alpha", platform);
  assertEquals(rotated.reloadPlan.nginx, true);
  assertEquals(rotated.reloadPlan.phpFpm.size, 0);
  assertEquals(rotated.reloadPlan.phpRunner.size, 0);

  const disabled = disableDeploy(rotated.state, "alpha", platform.clock.nowIso());
  assertEquals(disabled.reloadPlan.nginx, true);
  assertEquals(disabled.reloadPlan.phpFpm.has("php85"), true);
  assertEquals(disabled.reloadPlan.phpRunner.has("php85-runner"), true);
});

Deno.test("verifyDeploySignature accepts valid sha256", async () => {
  const body = new TextEncoder().encode('{"ref":"refs/heads/main"}');
  const secret = "topsecret";
  const hex = await hmacSha256(secret, body);
  const ok = await verifyDeploySignature(
    body,
    secret,
    `sha256=${hex}`,
    null,
  );
  assertEquals(ok, true);
  const bad = await verifyDeploySignature(body, secret, "sha256=deadbeef", null);
  assertEquals(bad, false);
});

Deno.test("enqueue auth and size limits", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    state = p.state;
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(state, { slug: "alpha" }, platform);
    state = enabled.state;
    const app = state.apps["alpha"]!;
    const home = platform.paths.appHome("alpha");
    // rewrite deploy meta after enable
    await materializeAppHome(platform, app, false);

    const body = new TextEncoder().encode("{}");
    const unauthorized = await enqueueDeploy(platform, app, home, body, {});
    assertEquals(unauthorized.ok, false);
    if (!unauthorized.ok) assertEquals(unauthorized.status, 401);

    const hex = await hmacSha256(enabled.secret, body);
    const ok = await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${hex}`,
    });
    assertEquals(ok.ok, true);
    if (ok.ok) assertEquals(ok.status, 202);

    // oversized
    const big = new Uint8Array(256 * 1024 + 1);
    const over = await enqueueDeploy(platform, app, home, big, {
      signature256: `sha256=${await hmacSha256(enabled.secret, big)}`,
    });
    assertEquals(over.ok, false);
    if (!over.ok) assertEquals(over.status, 413);

    // secret not in app-writable deploy.json
    const deployJson = await platform.fs.readText(join(home, ".bento", "deploy.json"));
    assertEquals(deployJson.includes(enabled.secret), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("latest policy supersedes queued jobs", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(p.state, { slug: "alpha", queuePolicy: "latest" }, platform);
    const app = enabled.state.apps["alpha"]!;
    const home = platform.paths.appHome("alpha");
    await materializeAppHome(platform, app, false);

    for (let i = 0; i < 3; i++) {
      const body = new TextEncoder().encode(`{"n":${i}}`);
      const hex = await hmacSha256(enabled.secret, body);
      const r = await enqueueDeploy(platform, app, home, body, {
        signature256: `sha256=${hex}`,
      });
      assertEquals(r.ok, true);
    }
    const queue = JSON.parse(
      await platform.fs.readText(join(home, ".bento", "queue.json")),
    ) as { jobs: DeployJob[] };
    const queued = queue.jobs.filter((j) => j.status === "queued");
    const superseded = queue.jobs.filter((j) => j.error === "superseded");
    assertEquals(queued.length, 1);
    assertEquals(superseded.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fifo rejects 21st queued job", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(p.state, { slug: "alpha", queuePolicy: "fifo" }, platform);
    const app = enabled.state.apps["alpha"]!;
    const home = platform.paths.appHome("alpha");
    await materializeAppHome(platform, app, false);

    for (let i = 0; i < 20; i++) {
      const body = new TextEncoder().encode(`{"n":${i}}`);
      const hex = await hmacSha256(enabled.secret, body);
      const r = await enqueueDeploy(platform, app, home, body, {
        signature256: `sha256=${hex}`,
      });
      assertEquals(r.ok, true);
    }
    const body = new TextEncoder().encode(`{"n":20}`);
    const hex = await hmacSha256(enabled.secret, body);
    const r = await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${hex}`,
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.status, 429);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("drain maps exit codes and keeps result on opcache failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const p = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    });
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(p.state, { slug: "alpha" }, platform);
    const app = enabled.state.apps["alpha"]!;
    const home = platform.paths.appHome("alpha");
    await materializeAppHome(platform, app, false);

    const body = new TextEncoder().encode("{}");
    const hex = await hmacSha256(enabled.secret, body);
    await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${hex}`,
    });

    const job = await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 99, log: "skipped by hook\n" }),
      resetOpcache: async () => ({ ok: false, detail: "fail" }),
    });
    assertEquals(job?.status, "skipped");
    assertEquals(job?.exitCode, 99);
    const log = await platform.fs.readText(join(home, "logs", job!.logName!));
    assertEquals(log.includes("opcache reset failed"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("drain success path", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const p = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    });
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(p.state, { slug: "alpha" }, platform);
    const app = enabled.state.apps["alpha"]!;
    const home = platform.paths.appHome("alpha");
    await materializeAppHome(platform, app, false);

    const body = new TextEncoder().encode("{}");
    await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${await hmacSha256(enabled.secret, body)}`,
    });

    const job = await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 0, log: "ok\n" }),
      resetOpcache: async () => ({ ok: true, detail: "reset" }),
    });
    assertEquals(job?.status, "success");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retainJobs keeps at most 30", () => {
  const jobs: DeployJob[] = [];
  for (let i = 0; i < 40; i++) {
    jobs.push({
      id: `dep_${i}` as never,
      status: "success",
      receivedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      finishedAt: `2026-01-01T00:01:${String(i).padStart(2, "0")}.000Z`,
    });
  }
  const kept = retainJobs(jobs);
  assertEquals(kept.length <= 30, true);
});
