/**
 * Phase E: TLS, PHP routing, deploy surface, permissions, status, migrations, compose inspect.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createEmptyState } from "../../src/domain/state.ts";
import { provisionApp } from "../../src/services/app.ts";
import { materializeAppHome } from "../../src/services/app.ts";
import {
  type DeployJob,
  drainDeploy,
  enableDeploy,
  enqueueDeploy,
  retainJobs,
} from "../../src/services/deploy.ts";
import { generateAll } from "../../src/services/generate.ts";
import {
  applyAppPermissionPolicy,
  checkPermissions,
  repairPermissions,
} from "../../src/services/permissions.ts";
import { buildStatus, formatStatus, statusToJson } from "../../src/services/status.ts";
import { assertSafeComposeArgs, resolveComposeFiles } from "../../src/services/compose.ts";
import {
  containerCertPath,
  resolveSslForSite,
  validateExternalTlsPaths,
} from "../../src/services/tls.ts";
import {
  migrateStateDocument,
  migrateV1toV2,
  migrationBackupName,
} from "../../src/schemas/migrations.ts";
import { loadStateFromJson, parseDesiredState, stateToJson } from "../../src/schemas/state.ts";
import { StateStore } from "../../src/services/state_store.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import { encodeHex } from "@std/encoding/hex";
import { STATE_SCHEMA_VERSION } from "../../src/version.ts";

function testPlatform(
  root: string,
  process?: ReturnType<typeof createRecordingProcessRunner>,
): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-17T12:00:00.000Z"),
    random: createSeededRandom("abcdef0123456789"),
    fs,
    lock: createMemoryLock(),
    process: process ?? createRecordingProcessRunner(),
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

// --- E1 TLS -----------------------------------------------------------------

Deno.test("E1 boot TLS: no HTTPS redirect, boot ssl include", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e1-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    state = p.state;
    const files = await generateAll(platform, state, "digest");
    const vhost = textContent(files.find((f) => f.relPath === "nginx/sites/alpha.conf")!.content);
    assertEquals(vhost.includes("return 301 https://"), false);
    assertEquals(vhost.includes("boot-ssl.conf"), true);
    assertEquals(vhost.includes("acme-challenge"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("E1 ACME TLS: redirect + challenge + ssl snippet paths", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e1-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    state = {
      ...p.state,
      apps: {
        alpha: {
          ...p.app,
          tls: { kind: "acme", email: "ops@example.com" },
        },
      },
    };
    const files = await generateAll(platform, state, "digest");
    const vhost = textContent(files.find((f) => f.relPath === "nginx/sites/alpha.conf")!.content);
    assertEquals(vhost.includes("return 301 https://"), true);
    assertEquals(vhost.includes(".well-known/acme-challenge"), true);
    assertEquals(vhost.includes("/var/www/acme"), true);
    assertEquals(vhost.includes("ssl-alpha.conf"), true);
    const snippet = textContent(
      files.find((f) => f.relPath === "nginx/snippets/ssl-alpha.conf")!.content,
    );
    assertEquals(snippet.includes("/etc/nginx/certs/acme/a.test/fullchain.pem"), true);
    assertEquals(snippet.includes("privkey.pem"), true);
    // Challenge location must appear even with redirect (not swallowed by return)
    const httpBlock = vhost.split("listen 443")[0]!;
    const challengeIdx = httpBlock.indexOf("acme-challenge");
    const redirectIdx = httpBlock.indexOf("return 301");
    assertEquals(challengeIdx >= 0 && redirectIdx > challengeIdx, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("E1 external TLS: validates paths and key mode", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e1-" });
  try {
    const platform = testPlatform(root);
    const certs = platform.paths.paths.certsDir;
    await platform.fs.mkdirp(certs);
    const cert = join(certs, "site.crt");
    const key = join(certs, "site.key");
    await platform.fs.atomicWriteText(cert, "CERT\n", 0o644);
    await platform.fs.atomicWriteText(key, "KEY\n", 0o644); // world-readable — reject

    let threw = false;
    try {
      await validateExternalTlsPaths(platform, "site.crt", "site.key");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    await platform.fs.chmod(key, 0o600);
    await validateExternalTlsPaths(platform, "site.crt", "site.key");

    const ssl = resolveSslForSite(
      { kind: "external", certPath: "site.crt", keyPath: "site.key" },
      "alpha",
      "a.test",
    );
    assertEquals(ssl.redirectHttps, true);
    assertEquals(ssl.snippetContent?.includes("/etc/nginx/certs/site.crt"), true);
    assertEquals(containerCertPath("site.crt"), "/etc/nginx/certs/site.crt");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E2 PHP routing ---------------------------------------------------------

Deno.test("E2 front-controller rejects non-index PHP; legacy allows scripts", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e2-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const fc = provisionApp(platform, state, {
      slug: "front",
      domain: "front.test",
      entrypointMode: "front-controller",
    });
    state = fc.state;
    const leg = provisionApp(platform, state, {
      slug: "legacy",
      domain: "legacy.test",
      entrypointMode: "legacy",
    });
    state = leg.state;

    const files = await generateAll(platform, state, "digest");
    const front = textContent(files.find((f) => f.relPath === "nginx/sites/front.conf")!.content);
    const legacy = textContent(files.find((f) => f.relPath === "nginx/sites/legacy.conf")!.content);

    // Front-controller: only index.php is executable; other .php return 404
    assertEquals(front.includes("if ($uri !~ ^/index\\.php$) { return 404; }"), true);
    assertEquals(front.includes("try_files $uri $uri/ /index.php?$query_string;"), true);
    // Must not use try_files $uri =404 for php (that would allow direct scripts)
    assertEquals(front.includes("try_files $uri =404;"), false);

    // Legacy: existing PHP files may execute
    assertEquals(legacy.includes("try_files $uri =404;"), true);
    assertEquals(legacy.includes("if ($uri !~ ^/index\\.php$)"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E3 Deploy HTTP surface -------------------------------------------------

Deno.test("E3 disabled deploy omits /_bento routes; enabled matches helpers", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e3-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const p = provisionApp(platform, state, { slug: "alpha", domain: "a.test" });
    state = p.state;
    // disabled by default
    let files = await generateAll(platform, state, "digest");
    let vhost = textContent(files.find((f) => f.relPath === "nginx/sites/alpha.conf")!.content);
    assertEquals(vhost.includes("/_bento/deploy"), false);
    assertEquals(vhost.includes("/_bento/clean-opcache"), false);
    assertEquals(vhost.includes("deploy-webhook.php"), false);

    const enabled = enableDeploy(state, { slug: "alpha" }, platform);
    state = enabled.state;
    files = await generateAll(platform, state, "digest");
    vhost = textContent(files.find((f) => f.relPath === "nginx/sites/alpha.conf")!.content);
    assertEquals(vhost.includes("location = /_bento/deploy"), true);
    assertEquals(vhost.includes("location = /_bento/clean-opcache"), true);
    assertEquals(
      vhost.includes("SCRIPT_FILENAME /opt/bento/helpers/deploy-webhook.php"),
      true,
    );
    assertEquals(
      vhost.includes("SCRIPT_FILENAME /opt/bento/helpers/clean-opcache.php"),
      true,
    );
    // default argv and container-local drain wiring
    const app = state.apps["alpha"]!;
    assertEquals(app.deploy.argv[0], "sh");
    assertEquals(app.deploy.argv[1], "/home/alpha/.bento/deploy.sh");
    const crontab = textContent(
      files.find((f) => f.relPath === "runner/php85/cron/alpha.crontab")!.content,
    );
    assertEquals(crontab.includes("/opt/bento/helpers/deploy-drain.sh alpha"), true);
    assertEquals(crontab.includes("/run/php-fpm/php85/alpha.sock"), true);
    assertEquals(crontab.includes("setpriv"), false);
    const scheduler = textContent(
      files.find((f) => f.relPath === "runner/php85/services/scheduler-alpha/run")!.content,
    );
    assertEquals(
      scheduler.includes(
        `/command/s6-applyuidgid -u ${app.uid} -g ${app.gid} -G '' sh -c`,
      ),
      true,
    );
    assertEquals(scheduler.includes("/usr/local/bin/supercronic"), true);
    assertEquals(scheduler.includes(">>/home/alpha/logs/cron.log 2>&1"), true);
    assertEquals(scheduler.includes("/var/log/bento"), false);
    assertEquals(scheduler.includes("setpriv"), false);
    const compose = textContent(
      files.find((f) => f.relPath === "compose/docker-compose.php-php85.yml")!.content,
    );
    assertEquals(
      compose.includes("./runtime/php-fpm/php85:/run/php-fpm/php85:ro"),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("E3 drain reclaim interrupted + log retention prune", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e3-" });
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

    // Seed a stale running job (started long ago)
    const stale: DeployJob = {
      id: "dep_stale" as never,
      status: "running",
      receivedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      logName: "deploy-dep_stale.log",
    };
    const queuePath = join(home, ".bento", "queue.json");
    await platform.fs.atomicWriteText(
      queuePath,
      JSON.stringify({ schemaVersion: 1, jobs: [stale] }, null, 2) + "\n",
      0o600,
    );
    await platform.fs.mkdirp(join(home, "logs"));
    await platform.fs.atomicWriteText(join(home, "logs", "deploy-dep_stale.log"), "old\n");

    // Enqueue a new job and drain — stale should be interrupted
    const body = new TextEncoder().encode("{}");
    await enqueueDeploy(platform, app, home, body, {
      signature256: `sha256=${await hmacSha256(enabled.secret, body)}`,
    });

    const job = await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 0, log: "ok\n" }),
      resetOpcache: async () => ({ ok: true, detail: "reset" }),
    });
    assertEquals(job?.status, "success");

    const queue = JSON.parse(await platform.fs.readText(queuePath)) as {
      jobs: DeployJob[];
    };
    const interrupted = queue.jobs.find((j) => j.id === "dep_stale");
    assertEquals(interrupted?.status, "failed");
    assertEquals(interrupted?.error, "interrupted");

    // Log prune: only retained job logs remain
    const many: DeployJob[] = [];
    for (let i = 0; i < 40; i++) {
      many.push({
        id: `dep_${i}` as never,
        status: "success",
        receivedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        finishedAt: `2026-01-01T00:01:${String(i).padStart(2, "0")}.000Z`,
        logName: `deploy-dep_${i}.log`,
      });
    }
    const kept = retainJobs(many);
    assertEquals(kept.length <= 30, true);
    for (const j of many) {
      await platform.fs.atomicWriteText(join(home, "logs", j.logName!), "x\n");
    }
    // Simulate prune via drain path: write queue with retained only then prune by re-drain empty
    await platform.fs.atomicWriteText(
      queuePath,
      JSON.stringify({ schemaVersion: 1, jobs: kept }, null, 2) + "\n",
      0o600,
    );
    // Call drain with no queued work — still reclaims/prunes via retain on next success path.
    // Directly invoke prune by running a successful empty-queue drain after planting logs.
    // Use retainJobs keep set to verify orphan logs would be removed by pruneDeployLogs:
    const keepNames = new Set(kept.map((j) => j.logName));
    const names = await platform.fs.readDir(join(home, "logs"));
    let orphans = 0;
    for (const n of names) {
      if (n.startsWith("deploy-") && n.endsWith(".log") && !keepNames.has(n)) orphans++;
    }
    assertEquals(orphans > 0, true); // pre-prune orphans exist
    // Run one more job so pruneDeployLogs executes
    const body2 = new TextEncoder().encode('{"n":1}');
    await enqueueDeploy(platform, app, home, body2, {
      signature256: `sha256=${await hmacSha256(enabled.secret, body2)}`,
    });
    await drainDeploy(platform, app, home, {
      runCommand: async () => ({ code: 0, log: "ok\n" }),
      resetOpcache: async () => ({ ok: true, detail: "ok" }),
    });
    const after = await platform.fs.readDir(join(home, "logs"));
    const leftoverOrphans = after.filter(
      (n) => n.startsWith("deploy-") && n.endsWith(".log") && !n.includes("dep_"),
    );
    // All deploy-*.log names should correspond to jobs still in queue
    const finalQueue = JSON.parse(await platform.fs.readText(queuePath)) as {
      jobs: DeployJob[];
    };
    const finalKeep = new Set(finalQueue.jobs.map((j) => j.logName).filter(Boolean));
    for (const n of after) {
      if (n.startsWith("deploy-") && n.endsWith(".log")) {
        assertEquals(finalKeep.has(n), true, `orphan log survived prune: ${n}`);
      }
    }
    void leftoverOrphans;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E4 Permissions ---------------------------------------------------------

Deno.test("E4 permissions walk does not follow symlink targets", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e4-" });
  try {
    const platform = testPlatform(root);
    const p = provisionApp(platform, createEmptyState(), {
      slug: "alpha",
      domain: "a.test",
    });
    await materializeAppHome(platform, p.app, false);
    const home = platform.paths.appHome("alpha");
    const code = join(home, "code");
    const outside = join(root, "outside-secret");
    await platform.fs.mkdirp(outside);
    await platform.fs.atomicWriteText(join(outside, "secret.txt"), "NOPE\n", 0o600);
    // Symlink from code/escape -> outside (must not be descended into)
    await Deno.symlink(outside, join(code, "escape"));

    const report = await checkPermissions(platform, p.state, "alpha", {
      recursive: true,
    });
    // Should not report issues under outside-secret via the symlink
    const leaked = report.issues.some((i) => i.path.includes("outside-secret"));
    assertEquals(leaked, false);

    // Repair recursive must not chmod the outside tree through the symlink
    const outsideModeBefore = (await Deno.lstat(join(outside, "secret.txt"))).mode ?? 0;
    await repairPermissions(platform, p.state, "alpha", {
      recursive: true,
    });
    const outsideModeAfter = (await Deno.lstat(join(outside, "secret.txt"))).mode ?? 0;
    assertEquals(outsideModeAfter & 0o777, outsideModeBefore & 0o777);

    // Shallow policy path still works
    const actions = await applyAppPermissionPolicy(platform, p.app, {
      recursive: false,
    });
    assertEquals(actions.some((a) => a.includes("identity")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E5 Status --------------------------------------------------------------

Deno.test("E5 status covers roles, domains, TLS, capacity, redacts secrets", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e5-" });
  try {
    // docker compose ps fails → roles unknown / config-ready notes
    const runner = createRecordingProcessRunner(async (cmd) => {
      if (cmd.includes("ps")) {
        return { code: 1, stdout: "", stderr: "cannot connect" };
      }
      return { code: 1, stdout: "", stderr: "unavailable" };
    });
    const platform = testPlatform(root, runner);
    let state = createEmptyState();
    const p = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.test",
      createDatabase: true,
    });
    state = p.state;
    // Force capacity warning: set processCap low
    state = {
      ...state,
      phpVersions: state.phpVersions.map((v) => ({ ...v, processCap: 1 })),
    };
    const store = new StateStore(platform);
    await platform.fs.mkdirp(root);
    await store.init(true);
    await store.save(state);

    const report = await buildStatus(platform, state);
    assertEquals(report.roles.length >= 4, true); // nginx, redis, php, runner, mysql
    assertEquals(report.apps[0]?.tls, "boot");
    assertEquals(report.apps[0]?.entrypointMode, "front-controller");
    assertEquals(report.domains.some((d) => d.domain === "a.test"), true);
    assertEquals(report.warnings.some((w) => w.toLowerCase().includes("cap")), true);
    assertEquals(report.notes.length >= 1, true);

    const human = formatStatus(report);
    assertEquals(human.includes("Roles:"), true);
    assertEquals(human.includes("Compose files"), true);
    assertEquals(human.toLowerCase().includes(p.app.mysqlPassword), false);

    const json = statusToJson(report);
    assertEquals(json.includes(p.app.mysqlPassword), false);
    assertEquals(json.includes("hmacSecret"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E6 Schema migrations ---------------------------------------------------

Deno.test("E6 future schemaVersion rejected; load does not rewrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e6-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    await store.init(true);
    const path = platform.paths.paths.stateFile;
    const original = await platform.fs.readText(path);

    // no-op load must not change bytes
    await store.load();
    assertEquals(await platform.fs.readText(path), original);

    const future = JSON.parse(original);
    future.schemaVersion = 999;
    const result = parseDesiredState(future);
    assertEquals(result.ok, false);

    // migrateV1toV2 pure function shape
    const v2 = migrateV1toV2({ schemaVersion: 1, apps: {} });
    assertEquals(v2.schemaVersion, 2);

    // migrateStateDocument no-op at current version
    const m = migrateStateDocument(JSON.parse(original));
    assertEquals(m.migrated, false);
    assertEquals(m.fromVersion, STATE_SCHEMA_VERSION);

    assertEquals(migrationBackupName(1, "2026-07-17T12:00:00.000Z").includes("v1"), true);

    // empty state round-trip preserves schema
    const loaded = loadStateFromJson(stateToJson(createEmptyState()));
    assertEquals(loaded.schemaVersion, STATE_SCHEMA_VERSION);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- E8 Overlay / Compose inspect -------------------------------------------

Deno.test("E8 overlay order is lexicographic; compose files lists them", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e8-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    const overlays = platform.paths.paths.overlaysDir;
    await platform.fs.mkdirp(overlays);
    // Create out of order; resolve must sort
    await platform.fs.atomicWriteText(join(overlays, "z-last.yml"), "services: {}\n");
    await platform.fs.atomicWriteText(join(overlays, "a-first.yml"), "services: {}\n");
    await platform.fs.atomicWriteText(join(overlays, "m-mid.yaml"), "services: {}\n");

    const files = await resolveComposeFiles(platform, state);
    const overlayFiles = files.filter((f) => f.startsWith("overlays/"));
    assertEquals(overlayFiles, [
      "overlays/a-first.yml",
      "overlays/m-mid.yaml",
      "overlays/z-last.yml",
    ]);
    // Base + php + mysql before overlays
    assertEquals(files[0]?.includes("docker-compose.base.yml"), true);
    assertEquals(files.indexOf("overlays/a-first.yml") > 0, true);

    assertThrows(() => assertSafeComposeArgs(["down", "--volumes"]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("E8 status includes compose file list with overlays", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-e8-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    await platform.fs.mkdirp(platform.paths.paths.overlaysDir);
    await platform.fs.atomicWriteText(
      join(platform.paths.paths.overlaysDir, "custom.yml"),
      "services: {}\n",
    );
    const report = await buildStatus(platform, state);
    assertEquals(report.composeFiles.some((f) => f === "overlays/custom.yml"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
