import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createEmptyState } from "../../src/domain/state.ts";
import { applyAppDataPlane, materializeAppHome, provisionApp } from "../../src/services/app.ts";
import {
  accountSetupSql,
  createAppDatabaseLive,
  execMysqlSql,
  grantSql,
  isMysqlReachable,
} from "../../src/services/mysql.ts";
import {
  aclRuleParts,
  aclRules,
  redisConnectionEnv,
  tryApplyAppRedisAcl,
} from "../../src/services/redis.ts";
import { generateMysqlSecrets } from "../../src/services/generate.ts";
import { parseDotEnv } from "../../src/services/stack_env.ts";
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
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

Deno.test("parseDotEnv reads MYSQL_ROOT_PASSWORD", () => {
  const env = parseDotEnv("# comment\nMYSQL_ROOT_PASSWORD=s3cret\nREDIS_PASSWORD=r1\n");
  assertEquals(env.MYSQL_ROOT_PASSWORD, "s3cret");
  assertEquals(env.REDIS_PASSWORD, "r1");
});

Deno.test("stack init generates the MySQL root password only once", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-mysql-init-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    await store.init();
    const initialEnv = await platform.fs.readText(platform.paths.paths.envFile);

    await store.init(true);
    const forcedInitEnv = await platform.fs.readText(platform.paths.paths.envFile);

    assertEquals(forcedInitEnv, initialEnv);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grantSql sets the password only when creating the app user", () => {
  const state = createEmptyState("2026-07-16T12:00:00.000Z");
  const platform = testPlatform("/tmp/unused");
  const { app } = provisionApp(platform, state, {
    slug: "myapp",
    domain: "my.test",
    createDatabase: true,
  });
  const sql = grantSql(app, "myapp", "p'ass\\word");
  assertEquals(sql.includes("CREATE DATABASE IF NOT EXISTS `myapp`"), true);
  // mysqlStringLiteral: \ -> \\ then ' -> \'
  assertEquals(sql.includes("IDENTIFIED BY 'p\\'ass\\\\word'"), true);
  assertEquals(sql.includes("ALTER USER"), false);
  // namespace grant pattern
  assertEquals(sql.includes("`myapp\\_%`"), true);
  // raw unescaped password fragment must not appear as a SQL string close
  assertEquals(/IDENTIFIED BY 'p'ass/.test(sql), false);
});

Deno.test("accountSetupSql does not create a database", () => {
  const platform = testPlatform("/tmp/unused");
  const { app } = provisionApp(platform, createEmptyState(), {
    slug: "alpha",
    domain: "a.test",
  });
  const sql = accountSetupSql(app, "secret");
  assertEquals(sql.includes("CREATE DATABASE"), false);
  assertEquals(sql.includes("CREATE USER"), true);
  assertEquals(sql.includes("ALTER USER"), false);
});

Deno.test("execMysqlSql keeps password off host argv (stdin only)", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-mysql-" });
  try {
    const password = "root-secret-value";
    const platform = testPlatform(root, () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await execMysqlSql(platform, "mysql84", "SELECT 1;", password);
    assertEquals(result.code, 0);
    assertEquals(platform.process.calls.length, 1);
    const call = platform.process.calls[0]!;
    const argvJoined = call.command.join(" ");
    assertEquals(argvJoined.includes(password), false);
    assertEquals(call.command.includes("docker"), true);
    assertEquals(call.command.includes("mysql84"), true);
    // password only on stdin
    const stdin = typeof call.options?.stdin === "string"
      ? call.options.stdin
      : new TextDecoder().decode(call.options?.stdin as Uint8Array);
    assertEquals(stdin.includes(`password=${password}`), true);
    assertEquals(stdin.includes("SELECT 1;"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit database fails before recording when MySQL exec fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-mysql-" });
  try {
    const platform = testPlatform(root, (cmd) => {
      // reachability true; grant fails
      if (cmd.includes("true")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "access denied" };
    });
    const store = new StateStore(platform);
    await store.init();
    let state = await store.load();
    const provisioned = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    });
    state = provisioned.state;
    await store.save(state);

    await assertRejects(
      () => createAppDatabaseLive(platform, state, "alpha", "alpha_main", "rootpw"),
      Error,
      "grant failed",
    );

    // state on disk unchanged — database not recorded
    const reloaded = await store.load();
    assertEquals(reloaded.apps["alpha"]?.databases.length ?? 0, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("explicit database fails when MySQL is unreachable", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-mysql-" });
  try {
    const platform = testPlatform(root, () => ({ code: 1, stdout: "", stderr: "not running" }));
    const store = new StateStore(platform);
    await store.init();
    let state = await store.load();
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;

    await assertRejects(
      () => createAppDatabaseLive(platform, state, "alpha", "alpha", "rootpw"),
      Error,
      "unavailable",
    );
    assertEquals(state.apps["alpha"]?.databases.length ?? 0, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyAppDataPlane with --db applies grants via exec when reachable", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-mysql-" });
  try {
    const platform = testPlatform(root, () => ({ code: 0, stdout: "ok", stderr: "" }));
    const store = new StateStore(platform);
    await store.init();
    const { app } = provisionApp(platform, await store.load(), {
      slug: "alpha",
      domain: "alpha.test",
      createDatabase: true,
    });
    const plane = await applyAppDataPlane(platform, app, { explicitDatabase: true });
    assertEquals(plane.mysqlApplied, true);
    // at least reachability + grant
    assertEquals(platform.process.calls.length >= 2, true);
    for (const call of platform.process.calls) {
      const joined = call.command.join("\0");
      assertEquals(joined.includes(app.mysqlPassword), false);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shared redis credentials include prefix and stack password", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-redis-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    await store.init();
    // seed shared redis password in stack env
    await platform.fs.atomicWriteText(
      platform.paths.paths.envFile,
      "MYSQL_ROOT_PASSWORD=root\nREDIS_PASSWORD=shared-secret\n",
      0o600,
    );
    const { app } = provisionApp(platform, await store.load(), {
      slug: "alpha",
      domain: "alpha.test",
    });
    assertEquals(app.redis.mode, "shared");
    assertEquals(app.redis.prefix, "alpha:");
    await materializeAppHome(platform, app, {
      recursivePerms: false,
      redisSharedPassword: "shared-secret",
    });
    const cred = await platform.fs.readText(
      join(platform.paths.appHome("alpha"), "credentials", "app.env"),
    );
    assertEquals(cred.includes("REDIS_PASSWORD=shared-secret"), true);
    assertEquals(cred.includes("REDIS_PREFIX=alpha:"), true);
    assertEquals(cred.includes("REDIS_MODE=shared"), true);
    // mysql password present in credentials file (restricted mode) but not in public tree
    assertEquals(cred.includes(`MYSQL_PASSWORD=${app.mysqlPassword}`), true);
    const env = redisConnectionEnv(app, "shared-secret");
    assertEquals(env.REDIS_PREFIX, "alpha:");
    assertEquals(env.REDIS_PASSWORD, "shared-secret");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ACL rules limit keys/channels to app prefix", () => {
  const identity = {
    mode: "acl" as const,
    prefix: "beta:",
    aclUsername: "app_beta",
    aclPassword: "acl-secret",
  };
  const rules = aclRules(identity);
  assertEquals(rules.length, 1);
  assertEquals(rules[0]!.includes("~beta:*"), true);
  assertEquals(rules[0]!.includes("&beta:*"), true);
  assertEquals(rules[0]!.includes("app_beta"), true);
  assertEquals(rules[0]!.includes(">acl-secret"), true);
  const parts = aclRuleParts(identity);
  assertEquals(parts.capabilityArgs.includes("~beta:*"), true);
  assertEquals(parts.capabilityArgs.includes("&beta:*"), true);
});

Deno.test("apply Redis ACL keeps secrets off host argv", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-redis-" });
  try {
    const platform = testPlatform(root, () => ({ code: 0, stdout: "OK", stderr: "" }));
    // Force ACL mode app
    let state = createEmptyState();
    state = {
      ...state,
      defaults: { ...state.defaults, redisMode: "acl" },
    };
    const { app } = provisionApp(platform, state, {
      slug: "gamma",
      domain: "gamma.test",
    });
    assertEquals(app.redis.mode, "acl");
    assertEquals(!!app.redis.aclPassword, true);

    const ok = await tryApplyAppRedisAcl(platform, app, "redis-auth");
    assertEquals(ok, true);
    for (const call of platform.process.calls) {
      const joined = call.command.join(" ");
      assertEquals(joined.includes(app.redis.aclPassword!), false);
      assertEquals(joined.includes("redis-auth"), false);
    }
    // secrets on stdin only
    const aclCall = platform.process.calls.find((c) =>
      c.command.includes("redis") && c.options?.stdin
    );
    assertEquals(!!aclCall, true);
    const stdin = String(aclCall!.options!.stdin);
    assertEquals(stdin.includes("redis-auth"), true);
    assertEquals(stdin.includes(app.redis.aclPassword!), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("root MySQL client option files get real password and mode 0600", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-rootcnf-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    const envText = await platform.fs.readText(platform.paths.paths.envFile);
    const env = parseDotEnv(envText);
    const rootPassword = env.MYSQL_ROOT_PASSWORD!;
    assertEquals(!!rootPassword, true);

    const state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const cnfPath = join(root, "generated/mysql/mysql84/root.cnf");
    assertEquals(await platform.fs.exists(cnfPath), true);
    const content = await platform.fs.readText(cnfPath);
    assertEquals(content.includes(`password=${rootPassword}`), true);
    assertEquals(content.includes("protocol=socket"), true);
    assertEquals(content.includes("socket=/var/run/mysqld/mysqld.sock"), true);
    assertEquals(content.includes("host=mysql84"), false);
    assertEquals(content.includes("{{MYSQL_ROOT_PASSWORD}}"), false);
    // no .tpl placeholder left
    assertEquals(
      await platform.fs.exists(join(root, "generated/mysql/mysql84/root.cnf.tpl")),
      false,
    );

    const st = await platform.fs.stat(cnfPath);
    assertEquals(st.mode & 0o777, 0o600);

    // pure generator unit
    const files = generateMysqlSecrets(state, "unit-test-pw");
    assertEquals(files.length, 1);
    assertEquals(files[0]!.relPath, "mysql/mysql84/root.cnf");
    assertEquals(files[0]!.mode, 0o600);
    assertEquals(String(files[0]!.content).includes("password=unit-test-pw"), true);
    assertEquals(String(files[0]!.content).includes("protocol=socket"), true);

    const compose = await platform.fs.readText(
      join(root, "generated/compose/docker-compose.mysql84.yml"),
    );
    assertEquals(compose.includes("./backups/mysql84:/var/backups/bento"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("root.cnf mode restored to 0600 after validation rollback", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-rootcnf-rb-" });
  try {
    const platform = testPlatform(root);
    const store = new StateStore(platform);
    const render = new RenderService(platform);
    await store.init();
    let state = await store.load();
    await render.apply(state, { renderOnly: true, skipValidate: true });

    const cnfPath = join(root, "generated/mysql/mysql84/root.cnf");
    const before = await platform.fs.readText(cnfPath);
    assertEquals((await platform.fs.stat(cnfPath)).mode & 0o777, 0o600);

    // mutate state then fail validation — previous generation restored
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.test",
    }).state;

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
        }),
      Error,
      "validation failed",
    );

    const after = await platform.fs.readText(cnfPath);
    assertEquals(after, before);
    assertEquals((await platform.fs.stat(cnfPath)).mode & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("isMysqlReachable reflects process exit code", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-ping-" });
  try {
    const up = testPlatform(root, () => ({ code: 0, stdout: "", stderr: "" }));
    assertEquals(await isMysqlReachable(up, "mysql84"), true);
    const down = testPlatform(root, () => ({ code: 1, stdout: "", stderr: "dead" }));
    assertEquals(await isMysqlReachable(down, "mysql84"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
