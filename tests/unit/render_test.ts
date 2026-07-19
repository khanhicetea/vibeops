import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { describeReloadPlan, reloadPlanForPoolChange } from "../../src/domain/reload.ts";
import { createEmptyState } from "../../src/domain/state.ts";
import { materializeAppHome, provisionApp } from "../../src/services/app.ts";
import { RenderService } from "../../src/services/render.ts";
import { StateStore } from "../../src/services/state_store.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import { assertSafeComposeArgs } from "../../src/services/compose.ts";
import { addPhpVersion, removePhpVersion } from "../../src/services/php.ts";
import { removeMysqlVersion } from "../../src/services/mysql.ts";

function testPlatform(root: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-16T12:00:00.000Z"),
    random: createSeededRandom("fedcba9876543210"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

Deno.test("init + render produces startable topology files", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const state = await store.load();
    const result = await render.apply(state, {
      renderOnly: true,
      skipValidate: true,
    });
    assertEquals(result.files.length > 0, true);
    const base = join(root, "generated/compose/docker-compose.base.yml");
    assertEquals(await platform.fs.exists(base), true);
    const nginxMain = await platform.fs.readText(join(root, "generated/nginx/nginx.conf"));
    assertEquals(nginxMain.includes("map $http_x_forwarded_proto $fastcgi_https"), true);
    assertEquals(nginxMain.includes("https 'on';"), true);
    assertEquals(nginxMain.includes("keys_zone=app_cache:10m max_size=1g"), true);
    assertEquals(nginxMain.includes("keys_zone=proxy_assets:20m max_size=2g"), true);
    assertEquals(nginxMain.includes("keys_zone=proxy_cache:10m max_size=1g"), true);
    // PHP and MySQL fragments
    assertEquals(
      await platform.fs.exists(join(root, "generated/compose/docker-compose.php-php85.yml")),
      true,
    );
    assertEquals(
      await platform.fs.exists(join(root, "generated/compose/docker-compose.mysql84.yml")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("render-only does not call reloader", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let reloads = 0;
    await render.apply(await store.load(), {
      renderOnly: true,
      skipValidate: true,
      reloader: {
        reload: async () => {
          reloads++;
        },
      },
    });
    assertEquals(reloads, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("successful reload reports the services in the executed plan", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const reported: string[][] = [];
    const render = new RenderService(platform, (plan) => {
      reported.push(describeReloadPlan(plan));
    });
    await store.init();
    const reloadPlan = reloadPlanForPoolChange("php85");

    const result = await render.apply(await store.load(), {
      skipValidate: true,
      reloadPlan,
      reloader: { reload: async () => {} },
    });

    assertEquals(reported, [["nginx", "php-fpm:php85"]]);
    assertEquals(describeReloadPlan(result.reloadPlan), ["nginx", "php-fpm:php85"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validation failure restores previous generation", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });
    const marker = join(root, "generated/MANIFEST.txt");
    const before = await platform.fs.readText(marker);

    // mutate state so generation differs
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;
    await store.save(state);

    await assertRejects(
      () =>
        render.apply(state, {
          skipValidate: false,
          validators: [{
            name: "fail",
            validate: async () => {
              throw new Error("boom");
            },
          }],
          reloader: { reload: async () => {} },
        }),
      Error,
      "validation failed",
    );

    const after = await platform.fs.readText(marker);
    assertEquals(after, before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reload failure keeps new generation", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
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

    await assertRejects(
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

    // New files should exist (app vhost)
    assertEquals(
      await platform.fs.exists(join(root, "generated/nginx/sites/alpha.conf")),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compose wrapper refuses down -v", () => {
  let threw = false;
  try {
    assertSafeComposeArgs(["down", "-v"]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("php remove constraints", () => {
  let state = createEmptyState();
  state = addPhpVersion(state, "8.3");
  // cannot remove default
  let threw = false;
  try {
    removePhpVersion(state, "8.5");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  // can remove unused non-default
  state = removePhpVersion(state, "8.3");
  assertEquals(state.phpVersions.some((v) => v.version === "8.3"), false);
});

Deno.test("mysql remove unsupported", () => {
  const state = createEmptyState();
  let threw = false;
  try {
    removeMysqlVersion(state, "8.4");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("app provision materializes home without secrets in public tree", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    const provisioned = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
      createDatabase: true,
    });
    await materializeAppHome(platform, provisioned.app);
    const home = platform.paths.appHome("alpha");
    assertEquals(await platform.fs.exists(join(home, "credentials", "app.env")), true);
    assertEquals(await platform.fs.exists(join(home, ".bento", "deploy.sh")), true);
    const queue = await platform.fs.readText(join(home, ".bento", "queue.json"));
    assertEquals(queue.includes("hmac"), false);

    // Applying an app created before structured logs repairs missing categories.
    await platform.fs.remove(join(home, "logs", "cron"), { recursive: true });
    await platform.fs.remove(join(home, "logs", "php"), { recursive: true });
    await platform.fs.remove(join(home, "logs", "worker"), { recursive: true });
    await new RenderService(platform).apply(provisioned.state, {
      renderOnly: true,
      skipValidate: true,
    });
    for (const category of ["cron", "php", "worker"]) {
      assertEquals(await platform.fs.exists(join(home, "logs", category)), true);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ondemand FPM profile renders only ondemand directives", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const render = new RenderService(platform);
    const state = provisionApp(platform, createEmptyState(), {
      slug: "idle-app",
      domain: "idle.example",
      fpmProfile: "ondemand",
    }).state;
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const pool = await platform.fs.readText(
      join(root, "generated/php/php85/pools/idle-app.conf"),
    );
    assertEquals(pool.includes("pm = ondemand"), true);
    assertEquals(pool.includes("pm.max_children = 10"), true);
    assertEquals(pool.includes("pm.process_idle_timeout = 10s"), true);
    assertEquals(pool.includes("pm.start_servers"), false);
    assertEquals(pool.includes("pm.min_spare_servers"), false);
    assertEquals(pool.includes("pm.max_spare_servers"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("app apply emits INI-safe pool marker, include file, and code/ docroot", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
      documentRoot: "public",
    }).state;
    await store.save(state);
    await render.apply(state, {
      renderOnly: true,
      skipValidate: true,
    });

    const pool = await platform.fs.readText(
      join(root, "generated/php/php85/pools/alpha.conf"),
    );
    assertEquals(pool.startsWith("; bento-managed: true\n"), true);
    assertEquals(pool.includes("# bento-managed"), false);
    assertEquals(pool.includes("[alpha]"), true);
    assertEquals(pool.includes("listen = /run/php-fpm/alpha.sock"), true);

    const includeFile = await platform.fs.readText(
      join(root, "generated/php/php85/zz-bento-pools.conf"),
    );
    assertEquals(includeFile.includes("include=/usr/local/etc/php-fpm.d/bento/*.conf"), true);

    const vhost = await platform.fs.readText(
      join(root, "generated/nginx/sites/alpha.conf"),
    );
    assertEquals(vhost.includes("root /home/alpha/code/public;"), true);
    assertEquals(vhost.includes("fastcgi_pass unix:/run/php-fpm/php85/alpha.sock;"), true);
    assertEquals(vhost.includes("fastcgi_param HTTPS $fastcgi_https;"), true);

    const phpCompose = await platform.fs.readText(
      join(root, "generated/compose/docker-compose.php-php85.yml"),
    );
    assertEquals(
      phpCompose.includes("zz-bento-pools.conf:/usr/local/etc/php-fpm.d/zz-bento-pools.conf:ro"),
      true,
    );
    assertEquals(
      phpCompose.includes(
        "entrypoint.sh:/usr/local/bin/bento-php-entrypoint:ro",
      ),
      true,
    );
    // PHP-FPM needs ptrace to write slow-request backtraces to each pool's slowlog.
    assertEquals(phpCompose.includes("SYS_PTRACE"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
