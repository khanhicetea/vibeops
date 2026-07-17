/**
 * Phase C — Render/apply hardening (R-01 … R-10, C1).
 */
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  emptyReloadPlan,
  type ReloadPlan,
  reloadPlanForDomainChange,
  reloadPlanForFullApply,
  reloadPlanForPoolChange,
  reloadPlanForRunnerChange,
} from "../../src/domain/reload.ts";
import { provisionApp } from "../../src/services/app.ts";
import { addPhpVersion } from "../../src/services/php.ts";
import { type GeneratedFile, type RenderResult, RenderService } from "../../src/services/render.ts";
import { StateStore } from "../../src/services/state_store.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import type { DesiredState } from "../../src/domain/state.ts";

function testPlatform(root: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-16T12:00:00.000Z"),
    random: createSeededRandom("c0ffee0123456789abcdef0123456789"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

async function snapshotGeneration(
  platform: Platform,
  root: string,
): Promise<Map<string, { content: string; mode: number }>> {
  const live = join(root, "generated");
  const out = new Map<string, { content: string; mode: number }>();
  const skip = new Set([
    ".staging",
    ".transaction-backup",
    ".render-journal.json",
    ".generation.json",
  ]);
  async function walk(dir: string, prefix: string) {
    if (!(await platform.fs.exists(dir))) return;
    for (const name of await platform.fs.readDir(dir)) {
      if (!prefix && skip.has(name)) continue;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = await platform.fs.stat(full);
      if (st.isDirectory) await walk(full, rel);
      else if (st.isFile) {
        out.set(rel, {
          content: await platform.fs.readText(full),
          mode: st.mode & 0o777,
        });
      }
    }
  }
  await walk(live, "");
  return out;
}

function assertSnapshotsEqual(
  before: Map<string, { content: string; mode: number }>,
  after: Map<string, { content: string; mode: number }>,
) {
  assertEquals([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, b] of before) {
    const a = after.get(rel)!;
    assertEquals(a.content, b.content, `content drift: ${rel}`);
    assertEquals(a.mode, b.mode, `mode drift: ${rel}`);
  }
}

// ---------------------------------------------------------------------------
// R-01 Concurrent mutations: exclusive lock serializes apply/state writers
// ---------------------------------------------------------------------------

Deno.test("R-01 exclusive lock serializes concurrent apply transactions", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r01-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const state = await store.load();

    let inCritical = 0;
    let maxInCritical = 0;
    // First apply holds the lock while second waits.
    let firstEntered = false;
    let secondStartedWaiting = false;
    let secondEnteredAfterFirst = false;

    const first = render.apply(state, {
      renderOnly: true,
      skipValidate: true,
      afterPromoteFile: async () => {
        // Hold during promote of the first real file
        if (firstEntered) return;
        firstEntered = true;
        inCritical++;
        maxInCritical = Math.max(maxInCritical, inCritical);
        // Let the second apply attempt start while we hold the lock
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        inCritical--;
      },
    });

    // Wait until first has entered critical section
    while (!firstEntered) {
      await new Promise((r) => setTimeout(r, 5));
    }
    secondStartedWaiting = true;

    const order: string[] = [];
    const second = (async () => {
      order.push("second-acquire-start");
      await render.apply(state, {
        renderOnly: true,
        skipValidate: true,
        afterPromoteFile: async () => {
          // If we ever overlap the first critical section, maxInCritical > 1
          inCritical++;
          maxInCritical = Math.max(maxInCritical, inCritical);
          secondEnteredAfterFirst = true;
          inCritical--;
        },
      });
      order.push("second-done");
    })();

    await first;
    order.push("first-done");
    await second;

    assertEquals(firstEntered, true);
    assertEquals(secondStartedWaiting, true);
    assertEquals(secondEnteredAfterFirst, true);
    // Exclusive lock must prevent overlapping critical sections.
    assertEquals(maxInCritical, 1);
    // First must complete before second finishes (serialization).
    assertEquals(order.indexOf("first-done") < order.indexOf("second-done"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("R-01 concurrent state withExclusive writers never overlap", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r01-state-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    await store.init();

    let concurrent = 0;
    let maxConcurrent = 0;
    const body = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return 1;
    };

    await Promise.all([
      store.withExclusive(body),
      store.withExclusive(body),
      store.withExclusive(body),
    ]);
    assertEquals(maxConcurrent, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-02 Candidate generation failure leaves live generation byte-identical
// ---------------------------------------------------------------------------

Deno.test("R-02 candidate generation failure leaves live generation byte-identical", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r02-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const before = await snapshotGeneration(platform, root);

    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);

    await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: true,
          candidateFactory: async () => {
            throw new Error("injected generator failure");
          },
        }),
      Error,
      "injected generator failure",
    );

    const after = await snapshotGeneration(platform, root);
    assertSnapshotsEqual(before, after);
    // No leftover journal/staging from a generation-phase failure
    assertEquals(
      await platform.fs.exists(join(root, "generated/.render-journal.json")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-03 Mid-promote failure restores all prior files and modes
// ---------------------------------------------------------------------------

Deno.test("R-03 mid-promote failure restores all prior files and modes", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r03-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    // Ensure a restricted-mode secret is part of the live generation
    const cnfPath = join(root, "generated/mysql/mysql84/root.cnf");
    assertEquals((await platform.fs.stat(cnfPath)).mode & 0o777, 0o600);

    const before = await snapshotGeneration(platform, root);

    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);

    let promoted = 0;
    await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: true,
          afterPromoteFile: async (rel) => {
            promoted++;
            // Fail after several files have been replaced live
            if (promoted >= 4) {
              throw new Error(`injected mid-promote failure at ${rel}`);
            }
          },
        }),
      Error,
      "mid-promote failure",
    );

    assertEquals(promoted >= 4, true);
    const after = await snapshotGeneration(platform, root);
    assertSnapshotsEqual(before, after);
    // Secret mode must survive rollback
    assertEquals((await platform.fs.stat(cnfPath)).mode & 0o777, 0o600);
    // New app vhost must not remain from the aborted promote
    assertEquals(
      await platform.fs.exists(join(root, "generated/nginx/sites/alpha.conf")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-04 Stale managed file removed only after full candidate promote
// ---------------------------------------------------------------------------

Deno.test("R-04 stale managed file survives mid-promote and is removed after success", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r04-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    // Plant a stale managed file under a managed tree
    const staleRel = "nginx/sites/stale-orphan.conf";
    const stalePath = join(root, "generated", staleRel);
    await platform.fs.writeText(
      stalePath,
      "# bento-managed: true\n# orphan from prior generation\n",
      0o644,
    );
    assertEquals(await platform.fs.exists(stalePath), true);

    // Mid-promote failure: stale must still be present
    let promoted = 0;
    await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: true,
          afterPromoteFile: async () => {
            promoted++;
            if (promoted >= 3) throw new Error("injected before stale removal");
          },
        }),
      Error,
      "injected before stale removal",
    );
    assertEquals(await platform.fs.exists(stalePath), true);

    // Successful apply: stale is removed only after full promote
    await render.apply(state, { renderOnly: true, skipValidate: true });
    assertEquals(await platform.fs.exists(stalePath), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-05 Validation failure restores previous generation; no reload signal
// ---------------------------------------------------------------------------

Deno.test("R-05 validation failure restores generation and never signals reload", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r05-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });
    const before = await snapshotGeneration(platform, root);

    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);

    let reloads = 0;
    await assertRejects(
      () =>
        render.apply(state, {
          validators: [{
            name: "fail",
            validate: async () => {
              throw new Error("nginx -t boom");
            },
          }],
          reloader: {
            reload: async () => {
              reloads++;
            },
          },
        }),
      Error,
      "validation failed",
    );

    assertEquals(reloads, 0);
    const after = await snapshotGeneration(platform, root);
    assertSnapshotsEqual(before, after);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-06 Only requested service groups signaled
// ---------------------------------------------------------------------------

Deno.test("R-06 reloader receives only requested service groups", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r06-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    state = addPhpVersion(state, "8.3");
    await store.save(state);

    const cases: Array<{ name: string; plan: ReloadPlan; expect: string[] }> = [
      {
        name: "domain-only",
        plan: reloadPlanForDomainChange(),
        expect: ["nginx"],
      },
      {
        name: "pool",
        plan: reloadPlanForPoolChange("php85"),
        expect: ["nginx", "php-fpm:php85"],
      },
      {
        name: "runner",
        plan: reloadPlanForRunnerChange("php85"),
        expect: ["php-runner:php85"],
      },
      {
        name: "full",
        plan: reloadPlanForFullApply(
          ["php85", "php83"],
          ["php85-runner", "php83-runner"],
        ),
        expect: [
          "nginx",
          "php-fpm:php83",
          "php-fpm:php85",
          "php-runner:php83-runner",
          "php-runner:php85-runner",
        ],
      },
      {
        name: "empty",
        plan: emptyReloadPlan(),
        expect: [],
      },
    ];

    for (const c of cases) {
      const seen: ReloadPlan[] = [];
      await render.apply(state, {
        skipValidate: true,
        reloadPlan: c.plan,
        reloader: {
          reload: async (plan) => {
            seen.push({
              nginx: plan.nginx,
              phpFpm: new Set(plan.phpFpm),
              phpRunner: new Set(plan.phpRunner),
            });
          },
        },
      });

      if (c.expect.length === 0) {
        assertEquals(seen.length, 0, `${c.name}: empty plan must not signal`);
        continue;
      }
      assertEquals(seen.length, 1, `${c.name}: one reload call`);
      const plan = seen[0]!;
      const targets: string[] = [];
      if (plan.nginx) targets.push("nginx");
      for (const s of [...plan.phpFpm].sort()) targets.push(`php-fpm:${s}`);
      for (const s of [...plan.phpRunner].sort()) targets.push(`php-runner:${s}`);
      assertEquals(targets, c.expect, `${c.name}: targets`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-07 Reload signal failure keeps validated new generation
// ---------------------------------------------------------------------------

Deno.test("R-07 reload failure keeps new generation and is actionable", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r07-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);

    const err = await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: true,
          reloader: {
            reload: async () => {
              throw new Error("signal failed");
            },
          },
        }),
      Error,
      "reload signal failed",
    );
    // Actionable / retryable messaging
    assertEquals(String(err).includes("new generation kept live"), true);
    assertEquals(String(err).includes("retry"), true);

    assertEquals(
      await platform.fs.exists(join(root, "generated/nginx/sites/alpha.conf")),
      true,
    );
    // Journal cleaned; generation remains
    assertEquals(
      await platform.fs.exists(join(root, "generated/.render-journal.json")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-08 Abandoned journal: next render restores deterministic generation
// ---------------------------------------------------------------------------

Deno.test("R-08 abandoned mid-promote journal is restored on next apply", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r08-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const manifestPath = join(root, "generated/MANIFEST.txt");
    const originalManifest = await platform.fs.readText(manifestPath);
    const originalMode = (await platform.fs.stat(manifestPath)).mode & 0o777;

    // Simulate crash mid-promote: corrupt live file, leave journal + backup
    const backupRoot = join(root, "generated/.transaction-backup");
    await platform.fs.mkdirp(backupRoot);
    await platform.fs.writeText(
      join(backupRoot, "MANIFEST.txt"),
      originalManifest,
      originalMode,
    );
    await platform.fs.writeText(
      manifestPath,
      "# bento-managed: true\nCORRUPTED-MID-PROMOTE\n",
      0o644,
    );
    // Also plant a new file that should be removed on rollback
    const ghostPath = join(root, "generated/nginx/sites/ghost.conf");
    await platform.fs.writeText(
      ghostPath,
      "# bento-managed: true\nghost\n",
      0o644,
    );

    const journal = {
      version: 1 as const,
      phase: "promoting" as const,
      startedAt: platform.clock.nowIso(),
      assetVersion: "test",
      entries: [
        {
          path: "MANIFEST.txt",
          existed: true,
          mode: originalMode,
          backupRel: "MANIFEST.txt",
        },
        {
          path: "nginx/sites/ghost.conf",
          existed: false,
        },
      ],
      promoted: ["MANIFEST.txt", "nginx/sites/ghost.conf"],
      staleToRemove: [] as string[],
      reloadPlan: { nginx: true, phpFpm: [] as string[], phpRunner: [] as string[] },
    };
    await platform.fs.atomicWriteText(
      join(root, "generated/.render-journal.json"),
      `${JSON.stringify(journal, null, 2)}\n`,
      0o600,
    );

    // recoverAbandoned via apply preamble
    const recovered = await render.recoverAbandoned();
    assertEquals(recovered, "restored");
    assertEquals(await platform.fs.readText(manifestPath), originalManifest);
    assertEquals((await platform.fs.stat(manifestPath)).mode & 0o777, originalMode);
    assertEquals(await platform.fs.exists(ghostPath), false);
    assertEquals(
      await platform.fs.exists(join(root, "generated/.render-journal.json")),
      false,
    );

    // Next apply succeeds from the restored generation
    await render.apply(state, { renderOnly: true, skipValidate: true });
    assertEquals(
      (await platform.fs.readText(manifestPath)).includes("CORRUPTED"),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("R-08 abandoned validating-phase journal restores previous generation", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r08-val-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    await render.apply(await store.load(), { renderOnly: true, skipValidate: true });

    const cnfPath = join(root, "generated/mysql/mysql84/root.cnf");
    const original = await platform.fs.readText(cnfPath);
    const originalMode = (await platform.fs.stat(cnfPath)).mode & 0o777;

    const backupRoot = join(root, "generated/.transaction-backup");
    await platform.fs.mkdirp(join(backupRoot, "mysql/mysql84"));
    await platform.fs.writeText(
      join(backupRoot, "mysql/mysql84/root.cnf"),
      original,
      originalMode,
    );
    // Simulate promoted-but-not-validated secret with wrong mode
    await platform.fs.writeText(cnfPath, `${original}\n# corrupted\n`, 0o644);

    await platform.fs.atomicWriteText(
      join(root, "generated/.render-journal.json"),
      `${
        JSON.stringify({
          version: 1,
          phase: "validating",
          startedAt: platform.clock.nowIso(),
          assetVersion: "test",
          entries: [{
            path: "mysql/mysql84/root.cnf",
            existed: true,
            mode: originalMode,
            backupRel: "mysql/mysql84/root.cnf",
          }],
          promoted: ["mysql/mysql84/root.cnf"],
          staleToRemove: [],
          reloadPlan: { nginx: false, phpFpm: [], phpRunner: [] },
        })
      }\n`,
      0o600,
    );

    assertEquals(await render.recoverAbandoned(), "restored");
    assertEquals(await platform.fs.readText(cnfPath), original);
    assertEquals((await platform.fs.stat(cnfPath)).mode & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-09 Render-only never signals services (keep green + explicit)
// ---------------------------------------------------------------------------

Deno.test("R-09 render-only never signals services even with non-empty plan", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r09-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let reloads = 0;
    await render.apply(await store.load(), {
      renderOnly: true,
      skipValidate: true,
      reloadPlan: reloadPlanForFullApply(["php85"], ["php85-runner"]),
      reloader: {
        reload: async () => {
          reloads++;
        },
      },
    });
    assertEquals(reloads, 0);
    assertEquals(await platform.fs.exists(join(root, "generated/nginx/nginx.conf")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-10 Secret file modes restricted across promote and rollback
// ---------------------------------------------------------------------------

Deno.test("R-10 secret modes stay 0600 across successful promote", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r10-ok-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const cnf = join(root, "generated/mysql/mysql84/root.cnf");
    assertEquals((await platform.fs.stat(cnf)).mode & 0o777, 0o600);

    // Second apply (content may change via state) keeps mode
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);
    await render.apply(state, { renderOnly: true, skipValidate: true });
    assertEquals((await platform.fs.stat(cnf)).mode & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("R-10 secret modes restored to 0600 after mid-promote rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-r10-rb-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const cnf = join(root, "generated/mysql/mysql84/root.cnf");
    const beforeContent = await platform.fs.readText(cnf);
    assertEquals((await platform.fs.stat(cnf)).mode & 0o777, 0o600);

    state = provisionApp(platform, state, {
      slug: "beta",
      domain: "beta.test",
    }).state;

    await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: true,
          afterPromoteFile: async (rel) => {
            // Abort right after the restricted secret file is promoted live
            if (rel === "mysql/mysql84/root.cnf" || rel.endsWith("/root.cnf")) {
              throw new Error("abort after secret promote");
            }
          },
        }),
      Error,
      "abort after secret promote",
    );

    assertEquals(await platform.fs.readText(cnf), beforeContent);
    assertEquals((await platform.fs.stat(cnf)).mode & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// C1 Compose fragment transactional safety
// ---------------------------------------------------------------------------

Deno.test("C1 compose fragments are managed and roll back with the generation", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-c1-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const phpFrag = join(root, "generated/compose/docker-compose.php-php85.yml");
    const mysqlFrag = join(root, "generated/compose/docker-compose.mysql84.yml");
    const base = join(root, "generated/compose/docker-compose.base.yml");
    assertEquals(await platform.fs.exists(phpFrag), true);
    assertEquals(await platform.fs.exists(mysqlFrag), true);
    assertEquals(await platform.fs.exists(base), true);

    const beforePhp = await platform.fs.readText(phpFrag);
    const beforeMysql = await platform.fs.readText(mysqlFrag);
    const beforeBase = await platform.fs.readText(base);

    // Mutate state so compose fragments would change (add PHP version)
    state = addPhpVersion(state, "8.3");
    await store.save(state);

    await assertRejects(
      () =>
        render.apply(state, {
          validators: [{
            name: "fail",
            validate: async () => {
              throw new Error("compose-or-service validation boom");
            },
          }],
          reloader: { reload: async () => {} },
        }),
      Error,
      "validation failed",
    );

    // Fragments restored byte-for-byte; new php83 fragment must not remain
    assertEquals(await platform.fs.readText(phpFrag), beforePhp);
    assertEquals(await platform.fs.readText(mysqlFrag), beforeMysql);
    assertEquals(await platform.fs.readText(base), beforeBase);
    assertEquals(
      await platform.fs.exists(
        join(root, "generated/compose/docker-compose.php-php83.yml"),
      ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("C1 compose config validator soft-skips when Docker unavailable", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-c1-soft-" });
  try {
    const fs = createFileSystem();
    const runs: string[][] = [];
    const platform: Platform = {
      clock: createFixedClock("2026-07-16T12:00:00.000Z"),
      random: createSeededRandom("c0ffee0123456789abcdef0000000001"),
      fs,
      lock: createMemoryLock(),
      process: {
        run: async (command) => {
          runs.push(command);
          // Simulate docker daemon down for compose config
          if (command.includes("config")) {
            return {
              code: 1,
              stdout: "",
              stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    // Must succeed (soft-skip), not throw
    await render.apply(await store.load(), {
      renderOnly: true,
      // exercise default validators including compose
      skipValidate: false,
      reloader: { reload: async () => {} },
    });
    const composeConfigCalls = runs.filter((c) =>
      c[0] === "docker" && c.includes("compose") && c.includes("config")
    );
    assertEquals(composeConfigCalls.length >= 1, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("C1 compose config validator fails closed on real config errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-c1-fail-" });
  try {
    const fs = createFileSystem();
    const platform: Platform = {
      clock: createFixedClock("2026-07-16T12:00:00.000Z"),
      random: createSeededRandom("c0ffee0123456789abcdef0000000002"),
      fs,
      lock: createMemoryLock(),
      process: {
        run: async (command) => {
          if (command.includes("config")) {
            return {
              code: 1,
              stdout: "",
              stderr: "services.nginx.volumes must be a list",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      assets: createAssetResolver(fs),
      paths: createPathPolicy(root),
    };
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    // First apply with skip to establish live gen
    const state = await store.load();
    await render.apply(state, {
      renderOnly: true,
      skipValidate: true,
    });
    const before = await platform.fs.readText(
      join(root, "generated/compose/docker-compose.base.yml"),
    );

    // Second apply with validators active should fail and restore
    await assertRejects(
      () =>
        render.apply(state, {
          renderOnly: true,
          skipValidate: false,
        }),
      Error,
      "validation failed",
    );
    assertEquals(
      await platform.fs.readText(
        join(root, "generated/compose/docker-compose.base.yml"),
      ),
      before,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Extra: candidateFactory can supply a full result (hook sanity)
// ---------------------------------------------------------------------------

Deno.test("candidateFactory override is used when provided", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-factory-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const state = await store.load();

    const files: GeneratedFile[] = [{
      relPath: "MANIFEST.txt",
      content: "# bento-managed: true\nfrom-factory\n",
      mode: 0o644,
      managed: true,
    }];
    const fake: RenderResult = {
      files,
      reloadPlan: emptyReloadPlan(),
      assetDigest: "deadbeef",
      managedManifest: ["MANIFEST.txt"],
    };

    await render.apply(state, {
      renderOnly: true,
      skipValidate: true,
      candidateFactory: async (_s: DesiredState) => fake,
    });
    assertEquals(
      await platform.fs.readText(join(root, "generated/MANIFEST.txt")),
      "# bento-managed: true\nfrom-factory\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
