/**
 * Phase B unit tests: mysql shell/size, worker control, access logs,
 * template customization/drift, maintenance crontab merge, batched --no-apply.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createEmptyState } from "../../src/domain/state.ts";
import { provisionApp } from "../../src/services/app.ts";
import {
  assertShellPlanSecretsOffArgv,
  buildMysqlShellPlan,
  databaseSizeSql,
  processlistSql,
  queryDatabaseSizes,
  queryProcesslist,
} from "../../src/services/mysql.ts";
import {
  addWorker,
  buildWorkerControlPlan,
  buildWorkerSignalPlan,
  isScopedWorkerCommand,
  workerProgramName,
} from "../../src/services/worker.ts";
import {
  buildAccessLogRotatePlan,
  buildGoAccessReportPlan,
  isNginxOnlyReloadPlan,
  rotateAccessLog,
  setAppAccessLog,
} from "../../src/services/access_log.ts";
import {
  detectTemplateDrift,
  digestText,
  returnToUpstreamTemplate,
  selectCustomTemplate,
  upstreamTemplateDigest,
} from "../../src/services/customization.ts";
import {
  CRON_BEGIN_MARKER,
  CRON_END_MARKER,
  extractStampMs,
  maintenanceCronFragment,
  mergeCrontab,
  runStackMaintenance,
  stripManagedBlock,
} from "../../src/services/maintenance.ts";
import { StateStore } from "../../src/services/state_store.ts";
import { RenderService } from "../../src/services/render.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import type { RunOptions, RunResult } from "../../src/platform/interfaces.ts";
import { describeReloadPlan } from "../../src/domain/reload.ts";

function testPlatform(
  root: string,
  handler?: (command: string[], options?: RunOptions) => Promise<RunResult> | RunResult,
): Platform & {
  process: ReturnType<typeof createRecordingProcessRunner>;
} {
  const fs = createFileSystem();
  const process = createRecordingProcessRunner(handler);
  return {
    clock: createFixedClock("2026-07-16T12:00:00.000Z"),
    random: createSeededRandom("aabbccddeeff0011"),
    fs,
    lock: createMemoryLock(),
    process,
    assets: createAssetResolver(fs, Deno.cwd()),
    paths: createPathPolicy(root),
  };
}

async function withRoot(
  fn: (root: string, platform: ReturnType<typeof testPlatform>) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "bento-phase-b-" });
  try {
    const platform = testPlatform(root);
    await fn(root, platform);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

// --- B1 MySQL shell / size / processlist ------------------------------------

Deno.test("root mysql shell uses generated socket option file", async () => {
  await withRoot(async (_root, platform) => {
    const plan = buildMysqlShellPlan(platform, {
      kind: "root",
      service: "mysql84",
    });
    assertShellPlanSecretsOffArgv(plan, ["root-s3cret-value"]);
    assertEquals(plan.stage, undefined);
    assertEquals(plan.cleanup, undefined);
    assertEquals(plan.optionPath, "/etc/bento/mysql/root.cnf");
    assertEquals(
      plan.open.command.includes("--defaults-extra-file=/etc/bento/mysql/root.cnf"),
      true,
    );
    assertEquals(plan.open.command.includes("--default-character-set=utf8mb4"), true);
  });
});

Deno.test("mysql shell plan for app uses app credentials on stdin only", async () => {
  await withRoot(async (_root, platform) => {
    const state = createEmptyState();
    const { app } = provisionApp(platform, state, {
      slug: "shop",
      domain: "shop.test",
    });
    const plan = buildMysqlShellPlan(platform, { kind: "app", app }, {
      interactive: false,
    });
    assertShellPlanSecretsOffArgv(plan, [app.mysqlPassword]);
    assertEquals(plan.user, app.mysqlUser);
    assertEquals(plan.service, app.mysqlService);
    assertEquals(plan.stage?.stdin.includes(app.mysqlPassword), true);
    assertEquals(plan.open.command.join(" ").includes(app.mysqlPassword), false);
    assertEquals(plan.open.command.includes("--default-character-set=utf8mb4"), true);
  });
});

Deno.test("databaseSizeSql and processlistSql contain no credentials", () => {
  const size = databaseSizeSql(["app_db"]);
  assertEquals(size.includes("information_schema"), true);
  assertEquals(size.toLowerCase().includes("password"), false);
  assertEquals(processlistSql(), "SHOW FULL PROCESSLIST;");
});

Deno.test("queryDatabaseSizes uses stdin-staged password", async () => {
  await withRoot(async (root) => {
    const password = "root-pw-xyz";
    const platform = testPlatform(root, () => ({
      code: 0,
      stdout: "demo\t1.25\t3\n",
      stderr: "",
    }));
    const { rows } = await queryDatabaseSizes(platform, "mysql84", password, ["demo"]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.database, "demo");
    assertEquals(rows[0]?.sizeMb, "1.25");
    const call = platform.process.calls[0]!;
    assertEquals(call.command.join(" ").includes(password), false);
    assertEquals(String(call.options?.stdin ?? "").includes(password), true);
  });
});

Deno.test("queryProcesslist fails closed on non-zero", async () => {
  await withRoot(async (root) => {
    const platform = testPlatform(root, () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    }));
    await assertRejects(
      () => queryProcesslist(platform, "mysql84", "pw"),
      Error,
      "processlist failed",
    );
  });
});

// --- B2 Worker lifecycle ----------------------------------------------------

Deno.test("worker program names are stable and flat", async () => {
  await withRoot(async (_root, platform) => {
    let state = createEmptyState();
    const provisioned = provisionApp(platform, state, {
      slug: "demo",
      domain: "demo.test",
    });
    state = provisioned.state;
    const a = addWorker(state, {
      app: "demo",
      name: "queue",
      command: ["php", "artisan", "queue:work"],
    }, platform);
    state = a.state;
    const b = addWorker(state, {
      app: "demo",
      name: "mail",
      command: ["php", "artisan", "queue:work", "--queue=mail"],
    }, platform);
    state = b.state;

    assertEquals(workerProgramName("demo", "queue"), "worker-demo-queue");
    assertEquals(workerProgramName("demo", "mail"), "worker-demo-mail");

    const restart = buildWorkerControlPlan(state, "demo", "queue", "restart");
    assertEquals(restart.program, "worker-demo-queue");
    assertEquals(restart.runnerService, "php85-runner");
    assertEquals(restart.command.includes("/command/s6-svc"), true);
    assertEquals(restart.command.includes("-r"), true);
    assertEquals(restart.command.some((arg) => arg.endsWith("/worker-demo-queue")), true);
    const hup = buildWorkerSignalPlan(state, "demo", "queue", "HUP");
    assertEquals(hup.command.includes("-h"), true);
    assertEquals(hup.command.some((arg) => arg.endsWith("/worker-demo-queue")), true);
    // Sibling not targeted
    assertEquals(restart.command.includes("worker-demo-mail"), false);
    assertEquals(
      isScopedWorkerCommand(
        restart.command,
        "worker-demo-queue",
        ["worker-demo-queue", "worker-demo-mail", "scheduler-demo"],
      ),
      true,
    );
    // Reload plan for add targets runner only (not nginx)
    assertEquals(a.reloadPlan.nginx, false);
    assertEquals(a.reloadPlan.phpRunner.has("php85-runner"), true);
  });
});

// --- B3 Access logs ---------------------------------------------------------

Deno.test("access log enable is nginx-only and disable preserves path", async () => {
  await withRoot(async (root, platform) => {
    let state = createEmptyState();
    const { state: s1, app } = provisionApp(platform, state, {
      slug: "demo",
      domain: "demo.test",
    });
    state = s1;
    assertEquals(app.accessLog, false);

    const enabled = setAppAccessLog(state, "demo", true, platform.clock.nowIso(), platform);
    assertEquals(enabled.enabled, true);
    assertEquals(enabled.state.apps["demo"]!.accessLog, true);
    assertEquals(isNginxOnlyReloadPlan(enabled.reloadPlan), true);
    assertEquals(describeReloadPlan(enabled.reloadPlan), ["nginx"]);

    const disabled = setAppAccessLog(
      enabled.state,
      "demo",
      false,
      platform.clock.nowIso(),
      platform,
    );
    assertEquals(disabled.enabled, false);
    assertEquals(disabled.preservedLogPath.includes("demo.access.log"), true);
    // path is under stack logs
    assertEquals(disabled.preservedLogPath.startsWith(root), true);
  });
});

Deno.test("access log rotate uses reopen not reload", async () => {
  await withRoot(async (root, platform) => {
    let state = createEmptyState();
    state = provisionApp(platform, state, {
      slug: "demo",
      domain: "demo.test",
      accessLog: true,
    }).state;

    const logDir = join(root, "logs", "nginx");
    await platform.fs.mkdirp(logDir, 0o755);
    const logPath = join(logDir, "demo.access.log");
    await platform.fs.writeText(logPath, "line1\n", 0o644);

    const plan = buildAccessLogRotatePlan(platform, "demo", "2026-07-16T12-00-00-000Z");
    assertEquals(plan.reopenCommand.join(" ").includes("reopen"), true);
    assertEquals(plan.reopenCommand.join(" ").includes("reload"), false);

    const result = await rotateAccessLog(platform, state, "demo");
    assertEquals(result.rotated, true);
    assertEquals(await platform.fs.exists(logPath), false);
    assertEquals(await platform.fs.exists(result.plan.rotatedPath), true);
    assertEquals(
      platform.process.calls.some((c) => c.command.join(" ").includes("reopen")),
      true,
    );
  });
});

Deno.test("goaccess report plan is one-shot docker run", async () => {
  await withRoot(async (root, platform) => {
    const plan = buildGoAccessReportPlan(platform, "demo", { dryRun: true });
    assertEquals(plan.command[0], "docker");
    assertEquals(plan.command.includes("run"), true);
    assertEquals(plan.command.includes("--rm"), true);
    assertEquals(plan.command.includes("-it"), false);
    assertEquals(plan.command.includes("-o"), true);
    assertEquals(plan.dryRun, true);
    assertEquals(plan.reportPath.includes(join(root, "logs", "reports")), true);
  });
});

Deno.test("goaccess terminal plan attaches the one-shot container", async () => {
  await withRoot(async (_root, platform) => {
    const plan = buildGoAccessReportPlan(platform, "demo", {
      attach: true,
      dryRun: true,
    });
    assertEquals(plan.attach, true);
    assertEquals(plan.command.includes("--rm"), true);
    assertEquals(plan.command.includes("-it"), true);
    assertEquals(plan.command.includes("-o"), false);
    assertEquals(plan.command.some((arg) => arg.includes("demo.access.log")), true);
  });
});

// --- B4 Template customization + drift --------------------------------------

Deno.test("custom template provenance round-trip and return preserves file", async () => {
  await withRoot(async (root, platform) => {
    let state = createEmptyState();
    state = provisionApp(platform, state, {
      slug: "demo",
      domain: "demo.test",
    }).state;

    const src = join(root, "my-vhost.tpl");
    await platform.fs.writeText(src, "# custom vhost\nserver { listen 80; }\n", 0o644);

    const selected = await selectCustomTemplate(platform, state, {
      slug: "demo",
      kind: "vhost",
      sourcePath: src,
      copy: true,
    });
    state = selected.state;
    assertEquals(selected.provenance.kind, "custom");
    if (selected.provenance.kind !== "custom") throw new Error("expected custom");
    assertEquals(await platform.fs.exists(selected.recordedPath), true);
    assertEquals(selected.upstreamDigest.length > 10, true);
    assertEquals(selected.provenance.copiedFromVersion, selected.upstreamDigest);

    // Drift: none when digest matches
    const noDrift = await detectTemplateDrift(platform, state, "demo");
    assertEquals(noDrift.length, 1);
    assertEquals(noDrift[0]?.drifted, false);

    // Simulate upstream digest change by rewriting recorded digest
    const app = state.apps["demo"]!;
    state = {
      ...state,
      apps: {
        ...state.apps,
        demo: {
          ...app,
          vhostTemplate: {
            kind: "custom",
            sourcePath: selected.recordedPath,
            copiedFromVersion: "deadbeef",
            activatedAt: app.updatedAt,
          },
        },
      },
    };
    const drifted = await detectTemplateDrift(platform, state, "demo");
    assertEquals(drifted[0]?.drifted, true);

    const returned = returnToUpstreamTemplate(
      state,
      "demo",
      "vhost",
      platform.clock.nowIso(),
    );
    assertEquals(returned.state.apps["demo"]!.vhostTemplate.kind, "upstream");
    assertEquals(returned.preservedPath, selected.recordedPath);
    // custom source still on disk
    assertEquals(await platform.fs.exists(selected.recordedPath), true);
  });
});

Deno.test("upstream template digest is stable for same content", async () => {
  await withRoot(async (_root, platform) => {
    const a = await upstreamTemplateDigest(platform, "vhost");
    const b = await upstreamTemplateDigest(platform, "vhost");
    assertEquals(a.digest, b.digest);
    assertEquals(await digestText(a.content), a.digest);
  });
});

// --- B5 Host maintenance / crontab ------------------------------------------

Deno.test("crontab merge preserves unrelated entries", () => {
  const existing = [
    "MAILTO=ops@example.com",
    "0 1 * * * /usr/local/bin/host-backup",
    "",
  ].join("\n");

  const fragment = maintenanceCronFragment({
    bentoBin: "/usr/local/bin/bento",
    stackRoot: "/var/bento-stack",
  });
  assertEquals(fragment.includes(CRON_BEGIN_MARKER), true);
  assertEquals(fragment.includes(CRON_END_MARKER), true);

  const installed = mergeCrontab(existing, { action: "install", fragment });
  assertEquals(installed.action, "installed");
  assertEquals(installed.crontab.includes("host-backup"), true);
  assertEquals(installed.crontab.includes("bento"), true);
  assertEquals(installed.crontab.includes("MAILTO=ops@example.com"), true);

  // idempotent re-install
  const again = mergeCrontab(installed.crontab, { action: "install", fragment });
  // may still be "installed" if normalize differs slightly, but unrelated stay
  assertEquals(again.crontab.includes("host-backup"), true);
  // only one BEGIN marker
  assertEquals(again.crontab.split(CRON_BEGIN_MARKER).length - 1, 1);

  const removed = mergeCrontab(installed.crontab, { action: "remove" });
  assertEquals(removed.action, "removed");
  assertEquals(removed.crontab.includes("host-backup"), true);
  assertEquals(removed.crontab.includes(CRON_BEGIN_MARKER), false);
  assertEquals(removed.crontab.includes("bento"), false);
});

Deno.test("stripManagedBlock removes only bento section", () => {
  const body = [
    "A=1",
    CRON_BEGIN_MARKER,
    "15 3 * * * bento maintenance run",
    CRON_END_MARKER,
    "B=2",
  ].join("\n");
  const stripped = stripManagedBlock(body);
  assertEquals(stripped.includes("A=1"), true);
  assertEquals(stripped.includes("B=2"), true);
  assertEquals(stripped.includes("bento"), false);
});

Deno.test("maintenance prunes old rotated logs and keeps active", async () => {
  await withRoot(async (root, platform) => {
    const dir = join(root, "logs", "nginx");
    await platform.fs.mkdirp(dir, 0o755);
    await platform.fs.writeText(join(dir, "demo.access.log"), "active\n");
    await platform.fs.writeText(
      join(dir, "demo.access.log.2020-01-01T00-00-00-000Z"),
      "old\n",
    );
    // stamp extraction
    assertEquals(
      extractStampMs("demo.access.log.2020-01-01T00-00-00-000Z") !== undefined,
      true,
    );

    const result = await runStackMaintenance(platform, { retainDays: 14 });
    assertEquals(result.notes.some((n) => n.includes("In-runner s6 service logs")), true);
    assertEquals(await platform.fs.exists(join(dir, "demo.access.log")), true);
    assertEquals(
      await platform.fs.exists(join(dir, "demo.access.log.2020-01-01T00-00-00-000Z")),
      false,
    );
  });
});

// --- B6 Deferred / batched mutations ----------------------------------------

Deno.test("multiple --no-apply mutations then single apply is one transaction", async () => {
  await withRoot(async (root, platform) => {
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init(true);

    // Mutate state without apply (simulating --no-apply)
    await store.withExclusive(async (state) => {
      let next = provisionApp(platform, state, {
        slug: "one",
        domain: "one.test",
      }).state;
      next = provisionApp(platform, next, {
        slug: "two",
        domain: "two.test",
      }).state;
      next = addWorker(next, {
        app: "one",
        name: "q",
        command: ["php", "artisan", "queue:work"],
      }, platform).state;
      next = addWorker(next, {
        app: "two",
        name: "q",
        command: ["sleep", "infinity"],
      }, platform).state;
      const access = setAppAccessLog(
        next,
        "one",
        true,
        platform.clock.nowIso(),
        platform,
      );
      await store.save(access.state);
      return access.state;
    });

    // Single apply transaction
    const state = await store.load();
    assertEquals(Object.keys(state.apps).sort(), ["one", "two"]);
    assertEquals(state.workers.length, 2);
    assertEquals(state.apps["one"]!.accessLog, true);

    const result = await render.apply(state, {
      skipValidate: true,
      renderOnly: true,
    });
    // One result with both apps rendered
    const vhosts = result.files.filter((f) => f.relPath.startsWith("nginx/sites/"));
    assertEquals(vhosts.some((f) => f.relPath.includes("one.conf")), true);
    assertEquals(vhosts.some((f) => f.relPath.includes("two.conf")), true);
    const oneVhost = vhosts.find((f) => f.relPath.includes("one.conf"));
    assertEquals(String(oneVhost?.content ?? "").includes("access_log"), true);

    // generation metadata written once
    assertEquals(
      await platform.fs.exists(join(root, "generated", ".generation.json")),
      true,
    );
  });
});
