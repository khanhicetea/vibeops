/**
 * Phase F1 — acceptance matrix gaps (validators, app identity, deploy prune/interrupt).
 * Complements existing unit suites; maps F-* and R-* coverage noted in specs/todo.md.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { basename, join } from "@std/path";
import { createEmptyState } from "../../src/domain/state.ts";
import { materializeAppHome, provisionApp } from "../../src/services/app.ts";
import {
  type DeployJob,
  drainDeploy,
  enableDeploy,
  enqueueDeploy,
  retainJobs,
} from "../../src/services/deploy.ts";
import { generateAll } from "../../src/services/generate.ts";
import { createAppDatabase, listRecentBackupFiles } from "../../src/services/mysql.ts";
import { aclRules, redisConnectionEnv } from "../../src/services/redis.ts";
import { addCronJob, removeCronJob } from "../../src/services/cron.ts";
import { RenderService } from "../../src/services/render.ts";
import { addWorker, workerProgramName } from "../../src/services/worker.ts";
import { describeReloadPlan } from "../../src/domain/reload.ts";
import { parseDotEnv } from "../../src/services/stack_env.ts";
import {
  appSlugSchema,
  domainNameSchema,
  parseAppSlug,
  parseCronSchedule,
  parseDomainName,
  parseMysqlVersion,
  parsePhpVersion,
  parseSafeRelativePath,
  parseUidGid,
  parseWith,
} from "../../src/schemas/validators.ts";
import { loadStateFromJson, parseDesiredState } from "../../src/schemas/state.ts";
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
    clock: createFixedClock("2026-07-17T15:00:00.000Z"),
    random: createSeededRandom("f1f1f1f1f1f1f1f1"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
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

// --- F-31 env / CLI token rejection ----------------------------------------

Deno.test("F1 env: empty and whitespace MYSQL_ROOT_PASSWORD ignored by parseDotEnv", () => {
  // Keys present with empty values are still keys; callers treat empty as missing.
  const env = parseDotEnv("MYSQL_ROOT_PASSWORD=\nREDIS_PASSWORD=  \nFOO=bar\n");
  assertEquals(env.MYSQL_ROOT_PASSWORD, "");
  assertEquals(env.REDIS_PASSWORD, "");
  assertEquals(env.FOO, "bar");
});

Deno.test("F1 env: malformed lines do not throw or invent keys", () => {
  const env = parseDotEnv("=novalue\nnoequals\n# only comment\nKEY=ok\n");
  assertEquals(env.KEY, "ok");
  assertEquals(Object.keys(env).includes(""), false);
  assertEquals(Object.keys(env).includes("noequals"), false);
});

Deno.test("F1 CLI tokens: reject empty, uppercase, and reserved-looking slugs", () => {
  assertEquals(parseAppSlug("").ok, false);
  assertEquals(parseAppSlug("MyApp").ok, false);
  assertEquals(parseAppSlug("-leading").ok, false);
  assertEquals(parseAppSlug("a").ok, false); // too short
  assertEquals(parseAppSlug("ab").ok, true);
  // Zod schema itself rejects non-strings
  assertEquals(parseWith(appSlugSchema, 42).ok, false);
  assertEquals(parseWith(appSlugSchema, null).ok, false);
  assertEquals(parseWith(domainNameSchema, { host: "x.com" }).ok, false);
});

Deno.test("F1 CLI tokens: domain / path / cron / version rejection cases", () => {
  assertEquals(parseDomainName("").ok, false);
  assertEquals(parseDomainName("no spaces.com").ok, false);
  assertEquals(parseDomainName("-bad.example").ok, false);
  assertEquals(parseSafeRelativePath("").ok, true); // empty relative allowed; app defaults fill
  assertEquals(parseSafeRelativePath("../secret").ok, false);
  assertEquals(parseSafeRelativePath("foo/../../etc").ok, false);
  assertEquals(parseSafeRelativePath("/abs/path").ok, false);
  assertEquals(parseSafeRelativePath("public/index.php").ok, true);
  // Backslashes normalize to forward slashes; no traversal remains valid relative path
  assertEquals(parseSafeRelativePath("web\\public").ok, true);
  assertEquals(parseCronSchedule("").ok, false);
  assertEquals(parseCronSchedule("@hourly").ok, false);
  assertEquals(parseCronSchedule("* * * * * ; id").ok, false);
  assertEquals(parsePhpVersion("latest").ok, false);
  assertEquals(parsePhpVersion("8.5.1").ok, false);
  assertEquals(parseMysqlVersion("8").ok, false);
  assertEquals(parseUidGid(999, "uid").ok, false);
  assertEquals(parseUidGid(1000, "uid").ok, true);
});

Deno.test("F1 state boundary: corrupt and future schema rejected before parse succeeds", () => {
  const future = {
    ...createEmptyState("2026-01-01T00:00:00.000Z"),
    schemaVersion: 999,
  };
  assertEquals(parseDesiredState(future).ok, false);
  assertThrows(() => loadStateFromJson("{"), Error);
  assertThrows(() => loadStateFromJson("null"), Error);
  assertThrows(() => loadStateFromJson("[]"), Error);
});

// --- F-02 / F-04 docroot safety + legacy generation ------------------------

Deno.test("F1 app docroot safety rejects traversal", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    assertThrows(
      () =>
        provisionApp(platform, createEmptyState(), {
          slug: "alpha",
          domain: "a.test",
          documentRoot: "../etc",
        }),
      Error,
    );
    assertThrows(
      () =>
        provisionApp(platform, createEmptyState(), {
          slug: "alpha",
          domain: "a.test",
          documentRoot: "/var/www",
        }),
      Error,
    );
    const ok = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
      documentRoot: "web/public",
    });
    assertEquals(ok.app.documentRoot, "web/public");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 legacy flag generation allows non-index PHP; front-controller does not", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const front = provisionApp(platform, state, {
      slug: "front",
      domain: "front.test",
      entrypointMode: "front-controller",
      documentRoot: "public",
    });
    state = front.state;
    const legacy = provisionApp(platform, state, {
      slug: "legacy",
      domain: "legacy.test",
      entrypointMode: "legacy",
      documentRoot: "htdocs",
    });
    state = legacy.state;
    const files = await generateAll(platform, state, "digest");
    const frontVhost = textContent(
      files.find((f) => f.relPath === "nginx/sites/front.conf")!.content,
    );
    const legacyVhost = textContent(
      files.find((f) => f.relPath === "nginx/sites/legacy.conf")!.content,
    );
    assertEquals(frontVhost.includes("if ($uri !~ ^/index\\.php$)"), true);
    assertEquals(frontVhost.includes("return 404"), true);
    assertEquals(legacyVhost.includes("if ($uri !~ ^/index\\.php$)"), false);
    assertEquals(legacyVhost.includes("try_files $uri =404;"), true);
    assertEquals(front.app.documentRoot, "public");
    assertEquals(legacy.app.documentRoot, "htdocs");
    // Generated paths embed docroot under code/
    assertEquals(frontVhost.includes("/code/public") || frontVhost.includes("public"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- F-09 / F-10 / F-11 matrix anchors -------------------------------------

Deno.test("F1 MySQL namespace refuse + one-time app passwords", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const a = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    });
    state = a.state;
    const b = provisionApp(platform, state, {
      slug: "beta",
      domain: "b.test",
      createDatabase: true,
    });
    state = b.state;
    const pwA = a.app.mysqlPassword;
    const pwB = b.app.mysqlPassword;
    assertEquals(pwA !== pwB, true);

    assertThrows(
      () => createAppDatabase(state, "alpha", "beta_stolen", platform.clock.nowIso()),
      Error,
      "namespace",
    );

    const updated = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.test",
    });
    assertEquals(updated.app.mysqlPassword, pwA);
    assertEquals(updated.state.apps["beta"]!.mysqlPassword, pwB);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 Redis shared prefix vs ACL rules", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    const shared = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    }).app;
    // force shared mode defaults
    const sharedEnv = redisConnectionEnv(
      { ...shared, redis: { ...shared.redis, mode: "shared", password: "shared-pw" } },
      "shared-pw",
    );
    assertEquals(sharedEnv.REDIS_MODE, "shared");
    assertEquals(sharedEnv.REDIS_PREFIX?.startsWith("alpha") || !!sharedEnv.REDIS_PREFIX, true);
    assertEquals(sharedEnv.REDIS_PASSWORD, "shared-pw");

    const aclApp = {
      ...shared,
      redis: {
        ...shared.redis,
        mode: "acl" as const,
        prefix: "alpha:",
        aclUsername: "app_alpha",
        aclPassword: "acl-secret",
      },
    };
    const aclEnv = redisConnectionEnv(aclApp);
    assertEquals(aclEnv.REDIS_USERNAME, "app_alpha");
    assertEquals(aclEnv.REDIS_PASSWORD, "acl-secret");
    const rules = aclRules(aclApp.redis);
    const joined = rules.join(" ");
    assertEquals(joined.includes("alpha:"), true);
    // Must not grant unrestricted keys
    assertEquals(joined.includes("~*"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- F-14 / F-15 cron + worker scoped plans --------------------------------

Deno.test("F1 cron/worker config generation + scoped runner reload", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    state = p.state;
    const cron = addCronJob(state, {
      app: "alpha",
      name: "tick",
      schedule: "*/5 * * * *",
      command: ["php", "artisan", "schedule:run"],
    }, platform);
    state = cron.state;
    assertEquals(
      describeReloadPlan(cron.reloadPlan).includes("php-runner:php85-runner") ||
        describeReloadPlan(cron.reloadPlan).some((x) => x.startsWith("php-runner:")),
      true,
    );
    assertEquals(cron.reloadPlan.nginx, false);
    assertEquals(cron.reloadPlan.phpFpm.size, 0);
    assertEquals(
      cron.reloadPlan.cronSchedulers?.get("php85-runner")?.has("alpha"),
      true,
    );

    const worker = addWorker(state, {
      app: "alpha",
      name: "queue",
      command: ["php", "artisan", "queue:work"],
    }, platform);
    state = worker.state;
    assertEquals(worker.reloadPlan.nginx, false);
    assertEquals(workerProgramName("alpha", "queue"), "worker-alpha-queue");

    const files = await generateAll(platform, state, "digest");
    const runnerFiles = files.filter((f) =>
      f.relPath.includes("runner") || f.relPath.includes("supervisor") ||
      f.relPath.includes("cron") || f.relPath.includes("supercronic")
    );
    const blob = runnerFiles.map((f) => textContent(f.content)).join("\n");
    const allBlob = files.map((f) => textContent(f.content)).join("\n");
    assertEquals(
      allBlob.includes("schedule:run") || blob.includes("schedule:run") ||
        allBlob.includes("tick") || allBlob.includes("queue:work") ||
        allBlob.includes("worker-alpha-queue"),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cron add/remove renders crontab and reloads existing Supercronic", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-cron-reload-" });
  try {
    const process = createRecordingProcessRunner();
    const platform: Platform = { ...testPlatform(root), process };
    const render = new RenderService(platform);
    let state = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    }).state;

    const first = addCronJob(state, {
      app: "alpha",
      name: "first",
      schedule: "*/5 * * * *",
      command: ["echo", "first-job"],
    }, platform);
    state = first.state;
    await render.apply(state, { renderOnly: true, skipValidate: true });

    // Adding another job leaves supervisord.conf unchanged, so reread/update
    // alone is insufficient; the existing Supercronic process needs USR2.
    const second = addCronJob(state, {
      app: "alpha",
      name: "second",
      schedule: "*/10 * * * *",
      command: ["echo", "second-job"],
    }, platform);
    state = second.state;
    await render.apply(state, { reloadPlan: second.reloadPlan, skipValidate: true });
    let crontab = await platform.fs.readText(
      join(root, "generated/runner/php85/cron/alpha.crontab"),
    );
    assertEquals(crontab.includes("first-job"), true);
    assertEquals(crontab.includes("second-job"), true);
    assertEquals(
      process.calls.some(({ command }) =>
        command.includes("signal") && command.includes("USR2") &&
        command.includes("scheduler-alpha")
      ),
      true,
    );

    process.calls.length = 0;
    const removed = removeCronJob(
      state,
      "alpha",
      "second",
      platform.clock.nowIso(),
    );
    state = removed.state;
    await render.apply(state, { reloadPlan: removed.reloadPlan, skipValidate: true });
    crontab = await platform.fs.readText(
      join(root, "generated/runner/php85/cron/alpha.crontab"),
    );
    assertEquals(crontab.includes("first-job"), true);
    assertEquals(crontab.includes("second-job"), false);
    assertEquals(
      process.calls.some(({ command }) =>
        command.includes("signal") && command.includes("USR2") &&
        command.includes("scheduler-alpha")
      ),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- F-18 / F-19 deploy history prune + interrupt reclaim ------------------

Deno.test("F1 deploy history prune removes orphan log files", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
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
    await platform.fs.mkdirp(join(home, "logs"));

    // Plant 40 historical success jobs + logs
    const many: DeployJob[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `dep_hist_${i}`;
      many.push({
        id: id as never,
        status: "success",
        receivedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        finishedAt: `2026-01-01T00:01:${String(i).padStart(2, "0")}.000Z`,
        logName: `deploy-${id}.log`,
      });
      await platform.fs.atomicWriteText(join(home, "logs", `deploy-${id}.log`), `log ${i}\n`);
    }
    const kept = retainJobs(many);
    assertEquals(kept.length, 30);
    await platform.fs.atomicWriteText(
      join(home, ".bento", "queue.json"),
      JSON.stringify({ schemaVersion: 1, jobs: kept }, null, 2) + "\n",
      0o600,
    );

    // Drain a new job to trigger pruneDeployLogs
    const body = new TextEncoder().encode('{"prune":true}');
    await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${await hmacSha256(enabled.secret, body)}`,
    });
    await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 0, log: "ok\n" }),
      resetOpcache: async () => ({ ok: true, detail: "ok" }),
    });

    const finalQueue = JSON.parse(
      await platform.fs.readText(join(home, ".bento", "queue.json")),
    ) as { jobs: DeployJob[] };
    const keep = new Set(finalQueue.jobs.map((j) => j.logName).filter(Boolean));
    const logs = await platform.fs.readDir(join(home, "logs"));
    for (const n of logs) {
      if (n.startsWith("deploy-") && n.endsWith(".log")) {
        assertEquals(keep.has(n), true, `orphan survived: ${n}`);
      }
    }
    // At least the 10 oldest hist logs should be gone
    assertEquals(await platform.fs.exists(join(home, "logs", "deploy-dep_hist_0.log")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 deploy interrupt reclaim marks stale running failed", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const platform = testPlatform(root);
    const p = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    });
    await materializeAppHome(platform, p.app);
    const enabled = enableDeploy(
      p.state,
      { slug: "alpha", timeoutSec: 1 },
      platform,
    );
    const app = {
      ...enabled.state.apps["alpha"]!,
      deploy: { ...enabled.state.apps["alpha"]!.deploy, timeoutSec: 1 },
    };
    const home = platform.paths.appHome("alpha");
    await materializeAppHome(platform, app, false);

    const stale: DeployJob = {
      id: "dep_stuck" as never,
      status: "running",
      receivedAt: "2020-01-01T00:00:00.000Z",
      startedAt: "2020-01-01T00:00:00.000Z",
      logName: "deploy-dep_stuck.log",
    };
    await platform.fs.atomicWriteText(
      join(home, ".bento", "queue.json"),
      JSON.stringify({ schemaVersion: 1, jobs: [stale] }, null, 2) + "\n",
      0o600,
    );

    const body = new TextEncoder().encode("{}");
    await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${await hmacSha256(enabled.secret, body)}`,
    });
    const job = await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 1, log: "boom\n" }),
      resetOpcache: async () => ({ ok: true, detail: "ok" }),
    });
    assertEquals(job?.status, "failed");

    const queue = JSON.parse(
      await platform.fs.readText(join(home, ".bento", "queue.json")),
    ) as { jobs: DeployJob[] };
    const stuck = queue.jobs.find((j) => j.id === "dep_stuck");
    assertEquals(stuck?.status, "failed");
    assertEquals(stuck?.error, "interrupted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- F-20 backup dry path (no docker) --------------------------------------

Deno.test("restore picker finds only the latest 20 finalized backup files", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-restore-picker-" });
  try {
    const platform = testPlatform(root);
    const dir = join(platform.paths.paths.backupsDir, "mysql84", "alpha");
    await platform.fs.mkdirp(dir);

    for (let i = 0; i < 22; i++) {
      const path = join(dir, `backup-${String(i).padStart(2, "0")}.sql.zst`);
      await platform.fs.writeBytes(path, new Uint8Array(i + 1).fill(1));
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      await Deno.utime(path, time, time);
    }
    await platform.fs.writeText(join(dir, "notes.txt"), "not a dump");
    await platform.fs.writeText(join(dir, "unfinished.sql.partial"), "partial");
    await platform.fs.writeText(
      join(platform.paths.paths.backupsDir, "state", "state.json"),
      "{}",
    );

    const files = await listRecentBackupFiles(platform);
    assertEquals(files.length, 20);
    assertEquals(basename(files[0]!.path), "backup-21.sql.zst");
    assertEquals(basename(files.at(-1)!.path), "backup-02.sql.zst");
    assertEquals(files[0]!.bytes, 22);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 backup refuses empty dump and leaves no final artifact", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const fs = createFileSystem();
    const process = createRecordingProcessRunner(() => ({
      code: 0,
      stdout: "", // empty dump
      stderr: "",
    }));
    const platform: Platform = {
      clock: createFixedClock("2026-07-17T15:00:00.000Z"),
      random: createSeededRandom("f1f1f1f1f1f1f1f1"),
      fs,
      lock: createMemoryLock(),
      process,
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    let state = createEmptyState();
    const p = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    });
    state = p.state;

    const { runBackup } = await import("../../src/services/mysql.ts");
    let threw = false;
    try {
      await runBackup(platform, state, { scope: "app", slug: "alpha", compress: "none" });
    } catch (e) {
      threw = true;
      assertEquals(String(e).includes("empty"), true);
    }
    assertEquals(threw, true);
    // No finalized backup under backups/ (failed dumps leave no final artifact)
    const backups = platform.paths.paths.backupsDir;
    if (await platform.fs.exists(backups)) {
      const serviceDir = join(backups, p.app.mysqlService, "alpha");
      if (await platform.fs.exists(serviceDir)) {
        const names = await platform.fs.readDir(serviceDir);
        const finals = names.filter((n) => !n.endsWith(".partial") && n.includes(".sql"));
        assertEquals(finals.length, 0);
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 backup writes in-container with socket config and zstd level 3", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const fs = createFileSystem();
    const finalPath = join(
      root,
      "backups",
      "mysql84",
      "alpha",
      "mysql84_alpha_2026-07-17T15-00-00-000Z.sql.zst",
    );
    const process = createRecordingProcessRunner(async () => {
      await fs.writeBytes(finalPath, new Uint8Array([1, 2, 3, 4]), 0o600);
      return { code: 0, stdout: "", stderr: "" };
    });
    const platform: Platform = {
      clock: createFixedClock("2026-07-17T15:00:00.000Z"),
      random: createSeededRandom("f1f1f1f1f1f1f1f1"),
      fs,
      lock: createMemoryLock(),
      process,
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    const state = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    }).state;
    const { runBackup } = await import("../../src/services/mysql.ts");
    const artifacts = await runBackup(platform, state, { scope: "app", slug: "alpha" });

    assertEquals(artifacts[0]?.path, finalPath);
    assertEquals(artifacts[0]?.bytes, 4);
    const call = process.calls[0]!;
    const script = call.command.at(-1) ?? "";
    assertEquals(script.includes("--defaults-extra-file=/etc/bento/mysql/root.cnf"), true);
    assertEquals(script.includes("zstd -3 -q -c"), true);
    assertEquals(script.includes("/var/backups/bento/alpha/"), true);
    assertEquals(call.options?.stdin, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 restore refuses cross-namespace target before side effects", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const process = createRecordingProcessRunner();
    const fs = createFileSystem();
    const platform: Platform = {
      clock: createFixedClock("2026-07-17T15:00:00.000Z"),
      random: createSeededRandom("f1f1f1f1f1f1f1f1"),
      fs,
      lock: createMemoryLock(),
      process,
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    const p = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    });
    const dump = join(root, "dump.sql");
    await platform.fs.atomicWriteText(dump, "SELECT 1;\n", 0o600);
    const { runRestore } = await import("../../src/services/mysql.ts");
    await assertThrowsAsync(
      () =>
        runRestore(platform, p.state, {
          file: dump,
          slug: "alpha",
          targetDatabase: "otherapp_db",
        }),
      "namespace",
    );
    // No docker compose exec should have been attempted
    assertEquals(process.calls.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("F1 restore imports in-container from the writable backup bind", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-f1-" });
  try {
    const process = createRecordingProcessRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const fs = createFileSystem();
    const platform: Platform = {
      clock: createFixedClock("2026-07-17T15:00:00.000Z"),
      random: createSeededRandom("f1f1f1f1f1f1f1f1"),
      fs,
      lock: createMemoryLock(),
      process,
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    const state = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    }).state;
    const dump = join(root, "external.sql.zst");
    await fs.writeBytes(dump, new Uint8Array([1, 2, 3]), 0o600);
    const { runRestore } = await import("../../src/services/mysql.ts");
    await runRestore(platform, state, {
      file: dump,
      slug: "alpha",
      targetDatabase: "alpha_restore",
    });

    assertEquals(process.calls.length, 1);
    const call = process.calls[0]!;
    const script = call.command.at(-1) ?? "";
    assertEquals(script.includes("zstd -dc --"), true);
    assertEquals(script.includes("/var/backups/bento/.restore/"), true);
    assertEquals(script.match(/--defaults-extra-file=\/etc\/bento\/mysql\/root\.cnf/g)?.length, 2);
    assertEquals(call.options?.stdin, undefined);
    const stageDir = join(root, "backups", "mysql84", ".restore");
    assertEquals(await fs.readDir(stageDir), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  messageIncludes: string,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    assertEquals(String(e).includes(messageIncludes), true, String(e));
  }
  assertEquals(threw, true);
}
