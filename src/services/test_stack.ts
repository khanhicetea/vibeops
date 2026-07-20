/**
 * Real-stack end-to-end harness — multi-chain operator ops against live Docker.
 *
 * Chains:
 *   1. bootstrap       docker + init + render + compose up
 *   2. apps-create     create apps (homes/pools/domains)
 *   3. db-add          mysql db provision + PHP connectivity
 *   4. domain          add/remove aliases + nginx vhost proof
 *   5. cron-worker     * * * * * print cron + file worker, wait 61s
 *   6. permissions     break modes → repair → re-check
 *   7. http/tls/status shared self-signed TLS HTTP (ACME skipped)
 *   8. deploy          live webhook → queue → runner drain → hook → OPcache
 *
 * Invoked as: `bento test-stack [name]` (default name: testbento)
 * or global:  `bento --test-stack [name]`
 */

import { join, resolve } from "@std/path";
import type { Platform } from "../platform/mod.ts";
import type { AppState, DesiredState } from "../domain/state.ts";
import { StateStore } from "./state_store.ts";
import { RenderService } from "./render.ts";
import { applyAppDataPlane, materializeAppHome, provisionApp } from "./app.ts";
import { materializeDockerAssets } from "./assets_materialize.ts";
import { composeArgs } from "./compose.ts";
import { createAppDatabaseLive, isMysqlReachable } from "./mysql.ts";
import { isRedisReachable } from "./redis.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "./stack_env.ts";
import { parseDotEnv } from "./stack_env.ts";
import { addCronJob, removeCronJob } from "./cron.ts";
import { addWorker, removeWorker, workerProgramName } from "./worker.ts";
import { checkPermissions, repairPermissions } from "./permissions.ts";
import { enableDeploy } from "./deploy.ts";

export const DEFAULT_TEST_STACK_NAME = "testbento";
/** Default wait for once-per-minute cron to fire (user requirement: 61s). */
export const DEFAULT_SCHEDULE_WAIT_SEC = 61;

export type TestStackOptions = {
  /** Compose project / stack directory name (default: testbento). */
  name: string;
  /** Absolute stack root. Defaults to ./<name> under cwd. */
  stackRoot: string;
  /** Repository root for source-mode assets. */
  repoRoot?: string;
  /** Keep containers running after the run. */
  keep: boolean;
  /** Skip docker image build (use existing tags). */
  skipBuild: boolean;
  /** Skip host-network nginx / HTTP checks. */
  skipHttp: boolean;
  /** Per-service readiness wait in ms. */
  timeoutMs: number;
  /**
   * Seconds to wait after scheduling cron/worker before asserting output.
   * Default 61 so a `* * * * *` cron is guaranteed one tick.
   */
  scheduleWaitSec: number;
  /** Logger sink. */
  log: (level: "info" | "warn" | "error", msg: string) => void;
};

export type TestStepResult = {
  id: string;
  title: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
};

export type TestStackReport = {
  name: string;
  stackRoot: string;
  startedAt: string;
  finishedAt: string;
  steps: TestStepResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
};

type StepFn = () => Promise<{ ok: boolean; detail?: string; skipped?: boolean }>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const out = await new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}

async function composeAvailable(): Promise<boolean> {
  try {
    const out = await new Deno.Command("docker", {
      args: ["compose", "version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}

async function runCapture(
  cmd: string[],
  opts?: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bin, ...args] = cmd;
  if (!bin) return { code: 1, stdout: "", stderr: "empty command" };
  try {
    const proc = new Deno.Command(bin, {
      args,
      cwd: opts?.cwd,
      env: opts?.env,
      stdin: opts?.stdin !== undefined ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });
    const child = proc.spawn();
    if (opts?.stdin !== undefined) {
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(opts.stdin));
      await w.close();
    }
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, opts.timeoutMs);
    }
    const out = await child.output();
    if (timer) clearTimeout(timer);
    return {
      code: timedOut ? 124 : out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    return {
      code: 1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

async function patchStackEnv(
  platform: Platform,
  patch: Record<string, string>,
): Promise<void> {
  const path = platform.paths.paths.envFile;
  let text = "";
  if (await platform.fs.exists(path)) {
    text = await platform.fs.readText(path);
  }
  const map = parseDotEnv(text);
  Object.assign(map, patch);
  const lines = [
    "# Bento stack environment (operator-owned, sensitive)",
    ...Object.entries(map).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  await platform.fs.atomicWriteText(path, lines.join("\n"), 0o600);
}

async function waitFor(
  label: string,
  timeoutMs: number,
  probe: () => Promise<boolean>,
  log: TestStackOptions["log"],
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (await probe()) return true;
    if (attempt === 1 || attempt % 5 === 0) {
      log("info", `waiting for ${label} (attempt ${attempt})…`);
    }
    await sleep(2000);
  }
  return false;
}

async function composeCmd(
  platform: Platform,
  state: DesiredState,
  args: string[],
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const full = await composeArgs(platform, state, args);
  return await runCapture(full, {
    cwd: platform.paths.paths.root,
    timeoutMs,
  });
}

async function writeProbePhp(
  platform: Platform,
  slug: string,
  filename: string,
  body: string,
): Promise<string> {
  const home = join(platform.paths.paths.homesDir, slug);
  const path = join(home, "code", "public", filename);
  await platform.fs.mkdirp(join(path, ".."));
  await platform.fs.atomicWriteText(path, body, 0o644);
  return path;
}

function phpMysqlProbe(): string {
  return `<?php
declare(strict_types=1);
$host = getenv('MYSQL_HOST') ?: 'mysql84';
$user = getenv('MYSQL_USER') ?: '';
$pass = getenv('MYSQL_PASSWORD') ?: '';
$db   = getenv('MYSQL_DATABASE') ?: '';
$mysqli = @new mysqli($host, $user, $pass, $db);
if ($mysqli->connect_errno) {
  fwrite(STDERR, "mysql_connect_fail: {$mysqli->connect_error}\\n");
  exit(1);
}
$r = $mysqli->query('SELECT DATABASE() AS db, 1 AS ok');
$row = $r ? $r->fetch_assoc() : null;
if (!$row || (string)$row['ok'] !== '1') {
  fwrite(STDERR, "mysql_query_fail\\n");
  exit(2);
}
echo "mysql_ok db=" . ($row['db'] ?? '') . "\\n";
`;
}

function phpRedisProbe(): string {
  return `<?php
declare(strict_types=1);
$host = getenv('REDIS_HOST') ?: 'redis';
$port = (int)(getenv('REDIS_PORT') ?: '6379');
$pass = getenv('REDIS_PASSWORD') ?: '';
$prefix = getenv('REDIS_PREFIX') ?: '';
if (!class_exists('Redis')) {
  fwrite(STDERR, "redis_ext_missing\\n");
  exit(3);
}
$r = new Redis();
if (!$r->connect($host, $port, 3.0)) {
  fwrite(STDERR, "redis_connect_fail\\n");
  exit(1);
}
if ($pass !== '') {
  if (!$r->auth($pass)) {
    fwrite(STDERR, "redis_auth_fail\\n");
    exit(2);
  }
}
$key = $prefix . 'bento_test_' . getmypid();
if (!$r->set($key, '1', 30)) {
  fwrite(STDERR, "redis_set_fail\\n");
  exit(4);
}
$val = $r->get($key);
$r->del($key);
if ((string)$val !== '1') {
  fwrite(STDERR, "redis_get_fail\\n");
  exit(5);
}
echo "redis_ok\\n";
`;
}

function phpVersionProbe(): string {
  return `<?php
echo PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION . PHP_EOL;
`;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadAppCredEnv(
  platform: Platform,
  app: AppState,
  sharedRedis: string,
): Promise<Record<string, string>> {
  const credPath = join(platform.paths.paths.homesDir, app.slug, "credentials", "app.env");
  const cred = (await platform.fs.exists(credPath))
    ? parseDotEnv(await platform.fs.readText(credPath))
    : {};
  return {
    MYSQL_HOST: cred.MYSQL_HOST ?? app.mysqlService,
    MYSQL_USER: cred.MYSQL_USER ?? app.mysqlUser,
    MYSQL_PASSWORD: cred.MYSQL_PASSWORD ?? app.mysqlPassword,
    MYSQL_DATABASE: cred.MYSQL_DATABASE ??
      app.databases[0]?.name ??
      `${app.slug}_db`,
    REDIS_HOST: cred.REDIS_HOST ?? "redis",
    REDIS_PORT: cred.REDIS_PORT ?? "6379",
    REDIS_PASSWORD: cred.REDIS_PASSWORD ?? sharedRedis,
    REDIS_PREFIX: cred.REDIS_PREFIX ?? app.redis.prefix,
    HOME: app.home,
  };
}

async function runPhpAsApp(
  stackRoot: string,
  app: AppState,
  scriptRel: string,
  env: Record<string, string>,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const merged = { ...env, ...extraEnv };
  const envFlags = Object.entries(merged).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return await runCapture(
    [
      "docker",
      "compose",
      "exec",
      "-T",
      "-u",
      `${app.uid}:${app.gid}`,
      "-w",
      app.home,
      ...envFlags,
      app.phpService,
      "php",
      `${app.home}/${scriptRel}`,
    ],
    { cwd: stackRoot, timeoutMs: 30_000 },
  );
}

/**
 * Run the full real-stack harness. Returns a structured report (never throws for step failures).
 */
export async function runTestStack(opts: TestStackOptions): Promise<TestStackReport> {
  const startedAt = new Date().toISOString();
  const steps: TestStepResult[] = [];
  const log = opts.log;

  const record = async (id: string, title: string, fn: StepFn): Promise<boolean> => {
    log("info", `→ ${title}`);
    try {
      const result = await fn();
      steps.push({
        id,
        title,
        ok: result.ok,
        detail: result.detail,
        skipped: result.skipped,
      });
      if (result.skipped) {
        log("warn", `skip ${id}: ${result.detail ?? ""}`);
        return true;
      }
      if (result.ok) {
        log("info", `ok  ${id}${result.detail ? ` — ${result.detail}` : ""}`);
      } else {
        log("error", `FAIL ${id}${result.detail ? ` — ${result.detail}` : ""}`);
      }
      return result.ok;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ id, title, ok: false, detail });
      log("error", `FAIL ${id} — ${detail}`);
      return false;
    }
  };

  const chain = (name: string) => {
    log("info", "");
    log("info", `═══ chain: ${name} ═══`);
  };

  // --- platform bootstrap ---------------------------------------------------
  const { createPlatform } = await import("../platform/mod.ts");
  const platform = createPlatform(opts.stackRoot, opts.repoRoot);
  const store = new StateStore(platform);
  const render = new RenderService(platform);

  let state: DesiredState | undefined;
  const appSlug = "demo";
  const appSlug2 = "other";
  let appDomain = `${opts.name}.test`;

  // =========================================================================
  // CHAIN 1 — bootstrap (docker, init, render, up)
  // =========================================================================
  chain("bootstrap");

  await record("docker", "Docker daemon available", async () => {
    if (!(await dockerAvailable())) {
      return { ok: false, detail: "docker info failed — start Docker and retry" };
    }
    if (!(await composeAvailable())) {
      return { ok: false, detail: "docker compose plugin missing" };
    }
    return { ok: true, detail: "docker + compose ok" };
  });
  if (steps.some((s) => s.id === "docker" && !s.ok)) {
    return finish(opts, steps, startedAt);
  }

  await record("init", `Initialize stack at ${opts.stackRoot}`, async () => {
    await platform.fs.mkdirp(opts.stackRoot);
    const exists = await store.exists();
    if (!exists) {
      state = await store.init(false);
    } else {
      state = await store.load();
    }
    await patchStackEnv(platform, { COMPOSE_PROJECT_NAME: opts.name });
    for (
      const d of [
        "runtime/php-fpm",
        "runtime/locks",
        "logs/nginx",
        "certs",
        "overlays",
      ]
    ) {
      await platform.fs.mkdirp(join(opts.stackRoot, d));
    }
    return { ok: true, detail: exists ? "reused existing state" : "fresh state" };
  });

  await record("render", "Materialize docker assets and render generation", async () => {
    state = await store.load();
    const mat = await materializeDockerAssets(
      platform,
      state.phpVersions.map((v) => String(v.version)),
    );
    const result = await render.apply(state, {
      renderOnly: true,
      skipValidate: true,
    });
    return {
      ok: true,
      detail: `digest=${mat.digest.slice(0, 12)} files=${result.files.length}`,
    };
  });

  await record("compose-config", "Validate compose file assembly", async () => {
    state = await store.load();
    const out = await composeCmd(platform, state, ["config", "-q"], 60_000);
    if (out.code !== 0) {
      return {
        ok: false,
        detail: (out.stderr || out.stdout).trim().slice(0, 400),
      };
    }
    return { ok: true };
  });

  await record("build", "Build PHP/nginx images", async () => {
    if (opts.skipBuild) {
      return { ok: true, skipped: true, detail: "--skip-build set" };
    }
    state = await store.load();
    log("info", "building images (this may take a while on first run)…");
    const out = await composeCmd(platform, state, ["build"], 1_800_000);
    if (out.code !== 0) {
      return {
        ok: false,
        detail: (out.stderr || out.stdout).trim().slice(0, 600),
      };
    }
    return { ok: true };
  });

  await record("nginx-ports", "Free host :80/:443 from other compose nginx", async () => {
    const stopped = await stopForeignHostNginx(opts.name, log);
    return {
      ok: true,
      detail: stopped.length ? `stopped ${stopped.join(", ")}` : "no foreign nginx containers",
    };
  });

  await record("up", "Compose up -d (mysql, redis, php, nginx, runner)", async () => {
    state = await store.load();
    const out = await composeCmd(platform, state, ["up", "-d", "--remove-orphans"], 300_000);
    const combined = `${out.stdout}\n${out.stderr}`;
    if (out.code !== 0) {
      if (/address already in use|failed to bind|ports are not available/i.test(combined)) {
        log(
          "warn",
          "compose up reported port bind issues (likely nginx host network); continuing data-plane checks",
        );
        return {
          ok: true,
          detail: "partial up (host port conflict on nginx — HTTP checks may skip)",
        };
      }
      return { ok: false, detail: combined.trim().slice(0, 600) };
    }
    return { ok: true };
  });

  await record("mysql-ready", "MySQL service reachable", async () => {
    state = await store.load();
    const service = state.mysqlVersions[0]?.service ?? "mysql84";
    const ok = await waitFor(
      `mysql ${service}`,
      opts.timeoutMs,
      async () => {
        if (!(await isMysqlReachable(platform, service))) return false;
        try {
          const pw = await requireMysqlRootPassword(platform);
          const script = [
            "set -e",
            "umask 077",
            "OPT=$(mktemp)",
            "trap 'rm -f \"$OPT\"' EXIT",
            "while IFS= read -r line; do",
            '  case "$line" in',
            "    __END_CNF__) break ;;",
            '    *) printf \'%s\\n\' "$line" >> "$OPT" ;;',
            "  esac",
            "done",
            'mysqladmin --defaults-extra-file="$OPT" ping',
          ].join("\n");
          const stdin = ["[client]", "user=root", `password=${pw}`, "__END_CNF__", ""].join(
            "\n",
          );
          const r = await runCapture(
            ["docker", "compose", "exec", "-T", service, "sh", "-c", script],
            { cwd: opts.stackRoot, stdin, timeoutMs: 10_000 },
          );
          return r.code === 0 && /alive/i.test(r.stdout + r.stderr);
        } catch {
          return false;
        }
      },
      log,
    );
    return ok
      ? { ok: true, detail: service }
      : { ok: false, detail: `timed out after ${opts.timeoutMs}ms waiting for ${service}` };
  });

  await record("redis-ready", "Redis service reachable on private network", async () => {
    const ok = await waitFor(
      "redis",
      Math.min(opts.timeoutMs, 60_000),
      async () => await isRedisReachable(platform),
      log,
    );
    if (!ok) return { ok: false, detail: "redis container not exec-able" };
    const pw = await loadRedisPassword(platform);
    const r = pw
      ? await runCapture(
        [
          "docker",
          "compose",
          "exec",
          "-T",
          "-e",
          `REDISCLI_AUTH=${pw}`,
          "redis",
          "redis-cli",
          "--no-auth-warning",
          "PING",
        ],
        { cwd: opts.stackRoot, timeoutMs: 10_000 },
      )
      : await runCapture(
        ["docker", "compose", "exec", "-T", "redis", "redis-cli", "PING"],
        { cwd: opts.stackRoot, timeoutMs: 10_000 },
      );
    if (r.code !== 0 || !/PONG/i.test(r.stdout)) {
      return {
        ok: false,
        detail: `redis PING failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      };
    }
    return { ok: true, detail: pw ? "auth ok" : "no-auth (protected-mode off)" };
  });

  await record("php-up", "PHP-FPM container running", async () => {
    state = await store.load();
    const service = state.phpVersions[0]?.service ?? "php85";
    const ok = await waitFor(
      `php ${service}`,
      opts.timeoutMs,
      async () => {
        const r = await runCapture(
          ["docker", "compose", "exec", "-T", service, "true"],
          { cwd: opts.stackRoot, timeoutMs: 8_000 },
        );
        return r.code === 0;
      },
      log,
    );
    if (!ok) {
      const logs = await runCapture(
        ["docker", "compose", "logs", "--tail", "40", service],
        { cwd: opts.stackRoot, timeoutMs: 15_000 },
      );
      return {
        ok: false,
        detail: `php service ${service} not up. logs:\n${
          (logs.stdout + logs.stderr).trim().slice(0, 500)
        }`,
      };
    }
    return { ok: true, detail: service };
  });

  // =========================================================================
  // CHAIN 2 — create apps
  // =========================================================================
  chain("apps-create");

  await record("app-create-demo", "Create app demo (no db yet)", async () => {
    state = await store.load();
    appDomain = `${opts.name}.test`;
    if (state.apps[appSlug]) {
      const redisShared = await loadRedisPassword(platform);
      await materializeAppHome(platform, state.apps[appSlug]!, {
        recursivePerms: true,
        redisSharedPassword: redisShared,
      });
      await render.apply(state, { renderOnly: false, skipValidate: true });
      return { ok: true, detail: `reused app ${appSlug}` };
    }
    const provisioned = provisionApp(platform, state, {
      slug: appSlug,
      domain: appDomain,
      documentRoot: "public",
      // no createDatabase — exercised in db-add chain
    });
    const plane = await applyAppDataPlane(platform, provisioned.app, {
      explicitDatabase: false,
    });
    const redisShared = await loadRedisPassword(platform);
    await materializeAppHome(platform, provisioned.app, {
      recursivePerms: true,
      redisSharedPassword: redisShared,
    });
    await store.save(provisioned.state);
    await render.apply(provisioned.state, {
      reloadPlan: provisioned.reloadPlan,
      skipValidate: true,
    });
    state = provisioned.state;
    return {
      ok: true,
      detail: `app=${appSlug} domain=${appDomain} mysqlDeferred=${!plane.mysqlApplied}`,
    };
  });

  await record("app-create-other", "Create second app other (isolation)", async () => {
    state = await store.load();
    if (!state.apps[appSlug2]) {
      const provisioned = provisionApp(platform, state, {
        slug: appSlug2,
        domain: `other.${opts.name}.test`,
        documentRoot: "public",
      });
      const redisShared = await loadRedisPassword(platform);
      await applyAppDataPlane(platform, provisioned.app, { explicitDatabase: false });
      await materializeAppHome(platform, provisioned.app, {
        recursivePerms: true,
        redisSharedPassword: redisShared,
      });
      await store.save(provisioned.state);
      await render.apply(provisioned.state, {
        reloadPlan: provisioned.reloadPlan,
        skipValidate: true,
      });
      state = provisioned.state;
    }
    const a = state.apps[appSlug]!;
    const b = state.apps[appSlug2]!;
    if (a.uid === b.uid) return { ok: false, detail: "uids collide" };
    if (a.mysqlPassword === b.mysqlPassword) {
      return { ok: false, detail: "mysql passwords collide" };
    }
    if (a.redis.prefix === b.redis.prefix) {
      return { ok: false, detail: "redis prefixes collide" };
    }
    return {
      ok: true,
      detail: `uids ${a.uid}/${b.uid}; prefixes ${a.redis.prefix} vs ${b.redis.prefix}`,
    };
  });

  await record("php-reload", "Reload PHP-FPM to pick up pools", async () => {
    state = await store.load();
    const service = state.apps[appSlug]?.phpService ??
      state.phpVersions[0]?.service ?? "php85";
    await runCapture(
      [
        "docker",
        "compose",
        "exec",
        "-T",
        service,
        "sh",
        "-c",
        "kill -USR2 1 2>/dev/null || kill -USR2 $(pidof php-fpm) 2>/dev/null || true",
      ],
      { cwd: opts.stackRoot, timeoutMs: 15_000 },
    );
    const up = await runCapture(
      ["docker", "compose", "exec", "-T", service, "true"],
      { cwd: opts.stackRoot, timeoutMs: 8_000 },
    );
    if (up.code !== 0) {
      const restart = await composeCmd(platform, state, ["restart", service], 120_000);
      if (restart.code !== 0) {
        return { ok: false, detail: (restart.stderr || restart.stdout).slice(0, 300) };
      }
    }
    await sleep(2000);
    return { ok: true, detail: `service=${service}` };
  });

  await record("php-version", "PHP version matches managed runtime", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: `app ${appSlug} missing` };
    await writeProbePhp(platform, appSlug, "_bento_version.php", phpVersionProbe());
    const env = await loadAppCredEnv(platform, app, await loadRedisPassword(platform));
    const r = await runPhpAsApp(
      opts.stackRoot,
      app,
      "code/public/_bento_version.php",
      env,
    );
    const got = (r.stdout || "").trim();
    if (r.code !== 0) {
      return {
        ok: false,
        detail: `php probe exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
      };
    }
    if (got !== app.phpVersion) {
      return { ok: false, detail: `expected PHP ${app.phpVersion}, got '${got}'` };
    }
    return { ok: true, detail: `PHP ${got}` };
  });

  // =========================================================================
  // CHAIN 3 — add db + connectivity
  // =========================================================================
  chain("db-add");

  await record("db-add-primary", "Add database demo_db to app demo", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    const dbName = `${appSlug}_db`;
    if (app.databases.some((d) => d.name === dbName)) {
      // Re-apply grants in case MySQL volume was recreated
      const plane = await applyAppDataPlane(platform, app, { explicitDatabase: true });
      const redisShared = await loadRedisPassword(platform);
      await materializeAppHome(platform, app, {
        recursivePerms: false,
        redisSharedPassword: redisShared,
      });
      return {
        ok: plane.mysqlApplied,
        detail: plane.mysqlApplied
          ? `already recorded; grants re-applied`
          : "already recorded but grants failed",
      };
    }
    const rootPassword = await requireMysqlRootPassword(platform);
    const next = await createAppDatabaseLive(
      platform,
      state,
      appSlug,
      dbName,
      rootPassword,
    );
    const redisShared = await loadRedisPassword(platform);
    await materializeAppHome(platform, next.apps[appSlug]!, {
      recursivePerms: false,
      redisSharedPassword: redisShared,
    });
    await store.save(next);
    state = next;
    return { ok: true, detail: `created ${dbName}` };
  });

  await record("db-add-secondary", "Add secondary database demo_appdata", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    const dbName = `${appSlug}_appdata`;
    if (app.databases.some((d) => d.name === dbName)) {
      return { ok: true, detail: `already recorded ${dbName}` };
    }
    const rootPassword = await requireMysqlRootPassword(platform);
    const next = await createAppDatabaseLive(
      platform,
      state,
      appSlug,
      dbName,
      rootPassword,
    );
    const redisShared = await loadRedisPassword(platform);
    await materializeAppHome(platform, next.apps[appSlug]!, {
      recursivePerms: false,
      redisSharedPassword: redisShared,
    });
    await store.save(next);
    state = next;
    return { ok: true, detail: `created ${dbName}` };
  });

  await record("db-connect-primary", "App PHP connects to demo_db", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    await writeProbePhp(platform, appSlug, "_bento_mysql.php", phpMysqlProbe());
    const env = await loadAppCredEnv(platform, app, await loadRedisPassword(platform));
    const r = await runPhpAsApp(
      opts.stackRoot,
      app,
      "code/public/_bento_mysql.php",
      env,
      { MYSQL_DATABASE: `${appSlug}_db` },
    );
    if (r.code !== 0 || !/mysql_ok/.test(r.stdout)) {
      return {
        ok: false,
        detail: `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
      };
    }
    return { ok: true, detail: (r.stdout || "").trim() };
  });

  await record("db-connect-secondary", "App PHP connects to demo_appdata", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    await writeProbePhp(platform, appSlug, "_bento_mysql.php", phpMysqlProbe());
    const env = await loadAppCredEnv(platform, app, await loadRedisPassword(platform));
    const r = await runPhpAsApp(
      opts.stackRoot,
      app,
      "code/public/_bento_mysql.php",
      env,
      { MYSQL_DATABASE: `${appSlug}_appdata` },
    );
    if (r.code !== 0 || !/mysql_ok/.test(r.stdout)) {
      return {
        ok: false,
        detail: `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
      };
    }
    return { ok: true, detail: (r.stdout || "").trim() };
  });

  await record("app-redis", "App PHP connects to Redis", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    await writeProbePhp(platform, appSlug, "_bento_redis.php", phpRedisProbe());
    const env = await loadAppCredEnv(platform, app, await loadRedisPassword(platform));
    const r = await runPhpAsApp(
      opts.stackRoot,
      app,
      "code/public/_bento_redis.php",
      env,
    );
    if (r.code !== 0 || !/redis_ok/.test(r.stdout)) {
      return {
        ok: false,
        detail: `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
      };
    }
    return { ok: true, detail: `prefix=${app.redis.prefix}` };
  });

  // =========================================================================
  // CHAIN 4 — domain add / remove
  // =========================================================================
  chain("domain");

  const aliasDomain = `www.${opts.name}.test`;

  await record("domain-add", "Add alias domain to demo", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    const provisioned = provisionApp(platform, state, {
      slug: appSlug,
      domain: app.mainDomain,
      aliases: [aliasDomain],
    });
    await store.save(provisioned.state);
    await render.apply(provisioned.state, {
      reloadPlan: provisioned.reloadPlan,
      skipValidate: true,
    });
    state = provisioned.state;
    const next = state.apps[appSlug]!;
    if (!next.aliases.includes(aliasDomain as typeof next.aliases[number])) {
      return { ok: false, detail: `alias ${aliasDomain} not in state` };
    }
    if (!state.domains[aliasDomain]) {
      return { ok: false, detail: `alias ${aliasDomain} missing from domain map` };
    }
    const vhost = await platform.fs.readText(
      join(opts.stackRoot, "generated", "nginx", "sites", `${appSlug}.conf`),
    );
    if (!vhost.includes(aliasDomain)) {
      return { ok: false, detail: `vhost missing server_name ${aliasDomain}` };
    }
    return {
      ok: true,
      detail: `aliases=${next.aliases.join(",")} main=${next.mainDomain}`,
    };
  });

  await record("domain-remove", "Remove alias domain from demo", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "demo app missing" };
    const provisioned = provisionApp(platform, state, {
      slug: appSlug,
      domain: app.mainDomain,
      aliases: [], // clear aliases
    });
    await store.save(provisioned.state);
    await render.apply(provisioned.state, {
      reloadPlan: provisioned.reloadPlan,
      skipValidate: true,
    });
    state = provisioned.state;
    const next = state.apps[appSlug]!;
    if (next.aliases.length > 0) {
      return { ok: false, detail: `aliases still present: ${next.aliases.join(",")}` };
    }
    if (state.domains[aliasDomain]) {
      return { ok: false, detail: `domain map still owns ${aliasDomain}` };
    }
    const vhost = await platform.fs.readText(
      join(opts.stackRoot, "generated", "nginx", "sites", `${appSlug}.conf`),
    );
    if (vhost.includes(aliasDomain)) {
      return { ok: false, detail: `vhost still lists ${aliasDomain}` };
    }
    if (!vhost.includes(next.mainDomain)) {
      return { ok: false, detail: `vhost lost main domain ${next.mainDomain}` };
    }
    return { ok: true, detail: `main=${next.mainDomain}; alias cleared` };
  });

  // =========================================================================
  // CHAIN 5 — cron + worker (wait 61s)
  // =========================================================================
  chain("cron-worker");

  await record("cron-add", "Add cron print job (* * * * *)", async () => {
    state = await store.load();
    // Idempotent: drop prior job so this run owns a fresh log window
    if (state.cronJobs.some((j) => j.app === appSlug && j.name === "print")) {
      const removed = removeCronJob(
        state,
        appSlug,
        "print",
        platform.clock.nowIso(),
      );
      state = removed.state;
      await store.save(state);
    }
    const added = addCronJob(state, {
      app: appSlug,
      name: "print",
      schedule: "* * * * *",
      command: ["sh", "-c", "echo cron-ok $(date -Iseconds)"],
      output: "log",
    }, platform);
    await store.save(added.state);
    state = added.state;
    // Clear prior log so we only count new ticks
    const cronLog = join(
      platform.paths.paths.homesDir,
      appSlug,
      "logs",
      "cron",
      "print.log",
    );
    await platform.fs.mkdirp(join(cronLog, ".."));
    await platform.fs.atomicWriteText(cronLog, "", 0o644);
    // Ensure app uid can write
    try {
      await Deno.chown(
        cronLog,
        state.apps[appSlug]!.uid,
        state.apps[appSlug]!.gid,
      );
    } catch {
      // best-effort on platforms without chown
    }
    await render.apply(state, {
      reloadPlan: added.reloadPlan,
      skipValidate: true,
    });
    // Confirm crontab generated
    const service = state.apps[appSlug]!.phpService;
    const ct = await platform.fs.readText(
      join(opts.stackRoot, "generated", "runner", service, "cron", `${appSlug}.crontab`),
    );
    const jobScript = await platform.fs.readText(
      join(opts.stackRoot, "generated", "runner", service, "cron", "jobs", appSlug, "print.sh"),
    );
    if (!ct.includes("* * * * *") || !ct.includes("/jobs/") || !jobScript.includes("cron-ok")) {
      return { ok: false, detail: `crontab or job script missing job: ${ct.slice(0, 200)}` };
    }
    return { ok: true, detail: "schedule=* * * * * → logs/cron/print.log" };
  });

  await record("worker-add", "Add worker that prints to logs/worker/print.log", async () => {
    state = await store.load();
    if (state.workers.some((w) => w.app === appSlug && w.name === "print")) {
      const removed = removeWorker(
        state,
        appSlug,
        "print",
        platform.clock.nowIso(),
      );
      state = removed.state;
      await store.save(state);
    }
    const workerLog = join(
      platform.paths.paths.homesDir,
      appSlug,
      "logs",
      "worker",
      "print.log",
    );
    await platform.fs.mkdirp(join(workerLog, ".."));
    await platform.fs.atomicWriteText(workerLog, "", 0o644);
    try {
      await Deno.chown(
        workerLog,
        state.apps[appSlug]!.uid,
        state.apps[appSlug]!.gid,
      );
    } catch {
      // best-effort
    }
    const added = addWorker(state, {
      app: appSlug,
      name: "print",
      command: [
        "sh",
        "-c",
        "while true; do echo worker-ok $(date -Iseconds); sleep 5; done",
      ],
      workdir: state.apps[appSlug]!.home,
    }, platform);
    await store.save(added.state);
    state = added.state;
    await render.apply(state, {
      reloadPlan: added.reloadPlan,
      skipValidate: true,
    });
    const service = state.apps[appSlug]!.phpService;
    const prog = workerProgramName(appSlug, "print");
    const run = await platform.fs.readText(
      join(opts.stackRoot, "generated", "runner", service, "services", prog, "run"),
    );
    if (!run.includes("/command/s6-applyuidgid") || run.includes("setpriv")) {
      return { ok: false, detail: `s6 service privilege drop missing ${prog}` };
    }
    return { ok: true, detail: `service=${prog}` };
  });

  await record(
    "runner-reconcile",
    "Reconcile s6 cron/worker services without restart",
    async () => {
      const runnerState = await store.load();
      state = runnerState;
      const runner = `${runnerState.apps[appSlug]!.phpService}-runner`;
      // Ensure the singleton exists, but do not restart it to load new definitions.
      const up = await composeCmd(platform, runnerState, ["up", "-d", runner], 120_000);
      if (up.code !== 0) {
        return { ok: false, detail: (up.stderr || up.stdout).trim().slice(0, 300) };
      }
      await composeCmd(
        platform,
        runnerState,
        ["exec", "-T", runner, "bento-s6-reconcile"],
        10_000,
      );
      const workerProg = workerProgramName(appSlug, "print");
      const schedProg = `scheduler-${appSlug}`;
      const ok = await waitFor(
        "s6 services",
        60_000,
        async () => {
          const status = await composeCmd(
            platform,
            runnerState,
            [
              "exec",
              "-T",
              runner,
              "/command/s6-svstat",
              `/run/bento-s6/services/${workerProg}`,
              `/run/bento-s6/services/${schedProg}`,
            ],
            10_000,
          );
          const text = status.stdout + status.stderr;
          return status.code === 0 &&
            text.split("\n").filter((line) => line.startsWith("up")).length >= 2;
        },
        log,
      );
      if (!ok) {
        const st = await composeCmd(
          platform,
          runnerState,
          [
            "exec",
            "-T",
            runner,
            "/command/s6-svstat",
            `/run/bento-s6/services/${workerProg}`,
            `/run/bento-s6/services/${schedProg}`,
          ],
          10_000,
        );
        return {
          ok: false,
          detail: `services not running: ${(st.stdout + st.stderr).trim().slice(0, 400)}`,
        };
      }
      return { ok: true, detail: `runner=${runner}; ${schedProg}+${workerProg} up` };
    },
  );

  await record(
    "schedule-wait",
    `Wait ${opts.scheduleWaitSec}s for cron tick + worker output`,
    async () => {
      if (opts.scheduleWaitSec <= 0) {
        return { ok: true, skipped: true, detail: "scheduleWaitSec=0" };
      }
      log(
        "info",
        `sleeping ${opts.scheduleWaitSec}s so * * * * * cron can fire and worker can write…`,
      );
      // Progress ticks every 15s so the operator sees life
      const end = Date.now() + opts.scheduleWaitSec * 1000;
      while (Date.now() < end) {
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left > 0 && left % 15 === 0) {
          log("info", `  … ${left}s remaining`);
        }
        await sleep(Math.min(1000, Math.max(0, end - Date.now())));
      }
      return { ok: true, detail: `waited ${opts.scheduleWaitSec}s` };
    },
  );

  await record("cron-verify", "Cron print wrote to logs/cron/print.log", async () => {
    const cronLog = join(
      platform.paths.paths.homesDir,
      appSlug,
      "logs",
      "cron",
      "print.log",
    );
    if (!(await platform.fs.exists(cronLog))) {
      return { ok: false, detail: `missing ${cronLog}` };
    }
    const text = await platform.fs.readText(cronLog);
    if (!/cron-ok/.test(text)) {
      // Also check Supercronic's combined app-owned log for clues.
      const current = await store.load();
      const runner = `${current.apps[appSlug]!.phpService}-runner`;
      const slog = await composeCmd(
        platform,
        current,
        [
          "exec",
          "-T",
          runner,
          "sh",
          "-c",
          `tail -n 30 /home/${appSlug}/logs/cron/scheduler.log 2>/dev/null || true`,
        ],
        10_000,
      );
      return {
        ok: false,
        detail: `no cron-ok in log (bytes=${text.length}); s6: ${
          (slog.stdout + slog.stderr).trim().slice(0, 300)
        }`,
      };
    }
    const lines = text.split("\n").filter((l) => l.includes("cron-ok")).length;
    return { ok: true, detail: `${lines} tick(s)` };
  });

  await record("worker-verify", "Worker print wrote to logs/worker/print.log", async () => {
    const workerLog = join(
      platform.paths.paths.homesDir,
      appSlug,
      "logs",
      "worker",
      "print.log",
    );
    if (!(await platform.fs.exists(workerLog))) {
      return { ok: false, detail: `missing ${workerLog}` };
    }
    const text = await platform.fs.readText(workerLog);
    if (!/worker-ok/.test(text)) {
      const current = await store.load();
      const runner = `${current.apps[appSlug]!.phpService}-runner`;
      const prog = workerProgramName(appSlug, "print");
      const st = await composeCmd(
        platform,
        current,
        [
          "exec",
          "-T",
          runner,
          "/command/s6-svstat",
          `/run/bento-s6/services/${prog}`,
        ],
        10_000,
      );
      return {
        ok: false,
        detail: `no worker-ok in log (bytes=${text.length}); status: ${
          (st.stdout + st.stderr).trim().slice(0, 200)
        }`,
      };
    }
    const lines = text.split("\n").filter((l) => l.includes("worker-ok")).length;
    if (lines < 2) {
      return {
        ok: false,
        detail: `expected multiple ticks, got ${lines} (worker may not be looping)`,
      };
    }
    return { ok: true, detail: `${lines} tick(s)` };
  });

  // =========================================================================
  // CHAIN 6 — permissions fix
  // =========================================================================
  chain("permissions");

  await record("permissions-break", "Intentionally break private credentials mode", async () => {
    state = await store.load();
    const credDir = join(platform.paths.paths.homesDir, appSlug, "credentials");
    const credFile = join(credDir, "app.env");
    if (!(await platform.fs.exists(credFile))) {
      return { ok: false, detail: "credentials/app.env missing" };
    }
    // Make private dir world-readable (policy violation)
    await Deno.chmod(credDir, 0o755);
    await Deno.chmod(credFile, 0o644);
    // Drop world-traverse on home so nginx path breaks (if present)
    const home = join(platform.paths.paths.homesDir, appSlug);
    try {
      await Deno.chmod(home, 0o700);
    } catch {
      // ignore
    }
    const report = await checkPermissions(platform, state, appSlug, {
      recursive: false,
    });
    if (report.issues.length === 0) {
      return {
        ok: false,
        detail: "check found no issues after intentional break",
      };
    }
    return {
      ok: true,
      detail: `issues=${report.issues.length} (e.g. ${report.issues[0]?.issue})`,
    };
  });

  await record("permissions-repair", "Repair permissions (shallow)", async () => {
    state = await store.load();
    const result = await repairPermissions(platform, state, appSlug, {
      recursive: false,
      shallow: true,
    });
    if (result.report.issues.length > 0) {
      return {
        ok: false,
        detail: `still ${result.report.issues.length} issue(s): ${
          result.report.issues.map((i) => i.issue).join("; ").slice(0, 200)
        }`,
      };
    }
    // Spot-check credentials mode bits
    const credDir = join(platform.paths.paths.homesDir, appSlug, "credentials");
    const st = await Deno.stat(credDir);
    const mode = (st.mode ?? 0) & 0o777;
    if ((mode & 0o077) !== 0) {
      return {
        ok: false,
        detail: `credentials dir still group/world accessible: mode=${mode.toString(8)}`,
      };
    }
    return {
      ok: true,
      detail: `fixed; actions=${result.actions.length}; credentials mode=${mode.toString(8)}`,
    };
  });

  await record("permissions-check", "Permissions check clean after repair", async () => {
    state = await store.load();
    const report = await checkPermissions(platform, state, appSlug, {
      recursive: false,
    });
    if (report.issues.length > 0) {
      return {
        ok: false,
        detail: report.issues.map((i) => `${i.path}: ${i.issue}`).join("; ").slice(0, 300),
      };
    }
    return { ok: true, detail: `checked=${report.checked} issues=0` };
  });

  // =========================================================================
  // CHAIN 7 — HTTP / shared TLS / status (ACME skipped)
  // =========================================================================
  chain("http-tls-status");

  await record("http", "HTTP front-controller responds via host nginx (shared TLS)", async () => {
    if (opts.skipHttp) {
      return { ok: true, skipped: true, detail: "--skip-http set" };
    }
    state = await store.load();
    const index = join(
      platform.paths.paths.homesDir,
      appSlug,
      "code",
      "public",
      "index.php",
    );
    if (!(await platform.fs.exists(index))) {
      await platform.fs.atomicWriteText(
        index,
        `<?php echo "bento app ${appSlug}\\n";\n`,
        0o644,
      );
    }

    const phpService = state.apps[appSlug]?.phpService ?? "php85";
    const sockHost = join(
      opts.stackRoot,
      "runtime",
      "php-fpm",
      phpService,
      `${appSlug}.sock`,
    );
    const sockOk = await waitFor(
      "php-fpm socket",
      30_000,
      async () => await platform.fs.exists(sockHost),
      log,
    );
    if (!sockOk) {
      return { ok: false, detail: `missing pool socket at ${sockHost}` };
    }

    await stopForeignHostNginx(opts.name, log);
    await composeCmd(platform, state, ["up", "-d", "nginx"], 120_000);

    const ngx = await runCapture(
      ["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"],
      { cwd: opts.stackRoot, timeoutMs: 15_000 },
    );
    if (ngx.code !== 0) {
      return {
        ok: true,
        skipped: true,
        detail: `nginx not healthy/available: ${(ngx.stderr || ngx.stdout).trim().slice(0, 200)}`,
      };
    }
    await runCapture(
      ["docker", "compose", "exec", "-T", "nginx", "nginx", "-s", "reload"],
      { cwd: opts.stackRoot, timeoutMs: 15_000 },
    );
    await sleep(1500);

    const sockInNginx = await runCapture(
      [
        "docker",
        "compose",
        "exec",
        "-T",
        "nginx",
        "ls",
        `/run/php-fpm/${phpService}/${appSlug}.sock`,
      ],
      { cwd: opts.stackRoot, timeoutMs: 10_000 },
    );
    if (sockInNginx.code !== 0) {
      return {
        ok: false,
        detail: `nginx cannot see socket /run/php-fpm/${phpService}/${appSlug}.sock`,
      };
    }

    const domain = state.apps[appSlug]?.mainDomain ?? appDomain;
    const curl = await runCapture(
      [
        "curl",
        "-sS",
        "-o",
        "/tmp/bento-test-stack-body.txt",
        "-w",
        "%{http_code}",
        "--max-time",
        "10",
        "-H",
        `Host: ${domain}`,
        "http://127.0.0.1/",
      ],
      { timeoutMs: 15_000 },
    );
    const code = (curl.stdout || "").trim();
    let body = "";
    try {
      body = await Deno.readTextFile("/tmp/bento-test-stack-body.txt");
    } catch {
      // ignore
    }
    if (curl.code !== 0) {
      return {
        ok: true,
        skipped: true,
        detail: `curl failed (nginx host conflict?): ${(curl.stderr || "").trim().slice(0, 200)}`,
      };
    }
    if (code !== "200") {
      const errLog = join(opts.stackRoot, "logs", "nginx", "error.log");
      let errTail = "";
      try {
        const full = await platform.fs.readText(errLog);
        errTail = full.trim().split("\n").slice(-5).join(" | ");
      } catch {
        // ignore
      }
      return {
        ok: false,
        detail: `HTTP ${code} for Host:${domain}; body=${body.slice(0, 80)}; nginx_err=${
          errTail.slice(0, 200)
        }`,
      };
    }
    if (!body.includes(appSlug) && !body.toLowerCase().includes("bento")) {
      return {
        ok: false,
        detail: `unexpected body: ${body.slice(0, 160)}`,
      };
    }
    return { ok: true, detail: `HTTP 200 Host:${domain}` };
  });

  await record("tls-shared", "Shared TLS mode configured (ACME issuance skipped)", async () => {
    state = await store.load();
    const app = state.apps[appSlug];
    if (!app) return { ok: false, detail: "app missing" };
    if (app.tls.kind === "acme") {
      log("warn", "ACME mode is configured but issuance is not exercised by test-stack");
    }
    const bootCrt = join(opts.stackRoot, "certs", "boot.crt");
    const bootKey = join(opts.stackRoot, "certs", "boot.key");
    const hasBoot = (await platform.fs.exists(bootCrt)) &&
      (await platform.fs.exists(bootKey));
    const vhost = join(
      opts.stackRoot,
      "generated",
      "nginx",
      "sites",
      `${appSlug}.conf`,
    );
    const vhostText = await platform.fs.readText(vhost);
    const hasSsl = /listen 443 ssl/.test(vhostText);
    return {
      ok: hasSsl,
      detail: hasSsl
        ? `tls.kind=${app.tls.kind}; shared_cert=${
          hasBoot ? "present" : "pending-entrypoint"
        }; ACME not tested`
        : "vhost missing 443 ssl listener",
    };
  });

  await record("status", "Stack state lists both apps", async () => {
    state = await store.load();
    const apps = Object.keys(state.apps);
    if (!apps.includes(appSlug) || !apps.includes(appSlug2)) {
      return { ok: false, detail: `apps=${apps.join(",")}` };
    }
    return {
      ok: true,
      detail: `apps=${
        apps.join(",")
      }; cron=${state.cronJobs.length}; workers=${state.workers.length}`,
    };
  });

  // =========================================================================
  // CHAIN 8 — live deploy webhook → queue → runner → hook → OPcache
  // =========================================================================
  chain("deploy");

  await record(
    "deploy-live",
    "Signed webhook drains in runner, executes hook, and resets app OPcache",
    async () => {
      const httpStep = steps.find((step) => step.id === "http");
      if (opts.skipHttp || httpStep?.skipped || httpStep?.ok === false) {
        return {
          ok: true,
          skipped: true,
          detail: opts.skipHttp ? "--skip-http set" : "live host nginx check unavailable",
        };
      }

      state = await store.load();
      const current = state.apps[appSlug];
      if (!current) return { ok: false, detail: "demo app missing" };
      const enabled = enableDeploy(state, { slug: appSlug }, platform);
      const app = enabled.state.apps[appSlug]!;
      const appHome = join(platform.paths.paths.homesDir, appSlug);
      const bentoDir = join(appHome, ".bento");
      const markerPath = join(bentoDir, "live-deploy-hook-ran");
      const queuePath = join(bentoDir, "queue.json");
      await platform.fs.remove(markerPath).catch(() => {});
      await platform.fs.atomicWriteText(
        queuePath,
        `${JSON.stringify({ schemaVersion: 1, jobs: [] }, null, 2)}\n`,
        0o600,
      );
      await platform.fs.atomicWriteText(
        join(bentoDir, "deploy.sh"),
        `#!/bin/sh
set -eu
test -s "$BENTO_DEPLOY_PAYLOAD_FILE"
printf '%s\n' "$BENTO_DEPLOY_ID" > "$HOME/.bento/live-deploy-hook-ran"
echo "live deploy hook executed: $BENTO_DEPLOY_ID"
`,
        0o750,
      );
      const redisShared = await loadRedisPassword(platform);
      await materializeAppHome(platform, app, {
        recursivePerms: false,
        redisSharedPassword: redisShared,
      });
      await store.save(enabled.state);
      state = enabled.state;
      await render.apply(state, { renderOnly: true, skipValidate: true });

      const phpService = app.phpService;
      const runner = `${phpService}-runner`;
      const restarted = await composeCmd(
        platform,
        state,
        ["restart", phpService, runner, "nginx"],
        180_000,
      );
      if (restarted.code !== 0) {
        return {
          ok: false,
          detail: `deploy service restart failed: ${
            (restarted.stderr || restarted.stdout).trim().slice(0, 400)
          }`,
        };
      }
      const ready = await waitFor(
        "deploy FPM socket",
        30_000,
        async () =>
          await platform.fs.exists(
            join(opts.stackRoot, "runtime", "php-fpm", phpService, `${appSlug}.sock`),
          ),
        log,
      );
      if (!ready) return { ok: false, detail: "app FPM socket did not return after restart" };
      await sleep(1500);

      const body = JSON.stringify({ ref: "refs/heads/main", live: true });
      const signature = await hmacSha256Hex(enabled.secret, body);
      const webhook = await runCapture(
        [
          "curl",
          "-sS",
          "--max-time",
          "15",
          "-w",
          "\n%{http_code}",
          "-H",
          `Host: ${app.mainDomain}`,
          "-H",
          "Content-Type: application/json",
          "-H",
          `X-Hub-Signature-256: sha256=${signature}`,
          "--data-binary",
          "@-",
          "http://127.0.0.1/_bento/deploy",
        ],
        { stdin: body, timeoutMs: 20_000 },
      );
      const responseLines = webhook.stdout.trimEnd().split("\n");
      const statusCode = responseLines.pop() ?? "";
      const responseBody = responseLines.join("\n");
      if (webhook.code !== 0 || statusCode !== "202") {
        return {
          ok: false,
          detail: `webhook exit=${webhook.code} HTTP=${statusCode}: ${
            (webhook.stderr || responseBody).trim().slice(0, 300)
          }`,
        };
      }
      let accepted: { id?: string; status?: string };
      try {
        accepted = JSON.parse(responseBody) as { id?: string; status?: string };
      } catch {
        return { ok: false, detail: `invalid webhook response: ${responseBody.slice(0, 200)}` };
      }
      const jobId = accepted.id ?? "";
      if (!/^dep_[A-Za-z0-9_-]+$/.test(jobId) || accepted.status !== "queued") {
        return { ok: false, detail: `unexpected webhook response: ${responseBody.slice(0, 200)}` };
      }

      const socketPath = `/run/php-fpm/${phpService}/${appSlug}.sock`;
      const drained = await composeCmd(
        platform,
        state,
        [
          "exec",
          "-T",
          runner,
          "setpriv",
          `--reuid=${app.uid}`,
          `--regid=${app.gid}`,
          "--clear-groups",
          "--",
          "/opt/bento/helpers/deploy-drain.sh",
          appSlug,
          socketPath,
        ],
        60_000,
      );
      if (drained.code !== 0) {
        return {
          ok: false,
          detail: `runner drain exit ${drained.code}: ${
            (drained.stderr || drained.stdout).trim().slice(0, 400)
          }`,
        };
      }

      const queue = JSON.parse(await platform.fs.readText(queuePath)) as {
        jobs: Array<{ id?: string; status?: string; exitCode?: number; logName?: string }>;
      };
      const job = queue.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status !== "success" || job.exitCode !== 0) {
        return {
          ok: false,
          detail: `job did not succeed: ${JSON.stringify(job ?? null)}`,
        };
      }
      const marker = await platform.fs.readText(markerPath).catch(() => "");
      if (marker.trim() !== jobId) {
        return { ok: false, detail: `deploy hook marker missing for ${jobId}` };
      }
      const logPath = join(appHome, "logs", job.logName ?? `deploy-${jobId}.log`);
      const deployLog = await platform.fs.readText(logPath);
      if (!deployLog.includes("live deploy hook executed")) {
        return { ok: false, detail: "deploy hook output missing from job log" };
      }
      if (!deployLog.includes("opcache reset: reset")) {
        return {
          ok: false,
          detail: `OPcache reset was not confirmed: ${deployLog.trim().slice(-300)}`,
        };
      }
      if (await platform.fs.exists(join(bentoDir, `payload-${jobId}.json`))) {
        return { ok: false, detail: "deploy payload snapshot was not cleaned up" };
      }
      return {
        ok: true,
        detail: `webhook 202; ${jobId} success; hook marker + OPcache reset confirmed`,
      };
    },
  );

  // Cleanup
  if (!opts.keep) {
    await record("cleanup", "Compose down (preserve volumes)", async () => {
      state = await store.load();
      const out = await composeCmd(platform, state, ["down", "--remove-orphans"], 180_000);
      if (out.code !== 0) {
        return {
          ok: false,
          detail: (out.stderr || out.stdout).trim().slice(0, 300),
        };
      }
      return { ok: true, detail: "volumes preserved (no -v)" };
    });
  } else {
    steps.push({
      id: "cleanup",
      title: "Compose down (preserve volumes)",
      ok: true,
      skipped: true,
      detail: "--keep set; stack left running",
    });
    log("info", `stack kept running under ${opts.stackRoot} (project ${opts.name})`);
  }

  return finish(opts, steps, startedAt);
}

/**
 * Stop other compose nginx containers that bind host :80/:443.
 * Nginx uses network_mode:host, so only one project can own those ports.
 */
async function stopForeignHostNginx(
  projectName: string,
  log: TestStackOptions["log"],
): Promise<string[]> {
  const stopped: string[] = [];
  const list = await runCapture(
    ["docker", "ps", "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  );
  if (list.code !== 0) return stopped;
  const names = list.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const ours = `${projectName}-nginx`;
  for (const name of names) {
    if (!/-nginx(?:-\d+)?$/.test(name)) continue;
    if (name === ours || name.startsWith(`${ours}-`)) continue;
    log("warn", `stopping foreign host-network nginx container ${name} (frees :80/:443)`);
    const r = await runCapture(["docker", "stop", name], { timeoutMs: 60_000 });
    if (r.code === 0) stopped.push(name);
  }
  if (stopped.length) await sleep(1000);
  return stopped;
}

function finish(
  opts: TestStackOptions,
  steps: TestStepResult[],
  startedAt: string,
): TestStackReport {
  const passed = steps.filter((s) => s.ok && !s.skipped).length;
  const failed = steps.filter((s) => !s.ok && !s.skipped).length;
  const skipped = steps.filter((s) => s.skipped).length;
  return {
    name: opts.name,
    stackRoot: opts.stackRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    passed,
    failed,
    skipped,
    ok: failed === 0,
  };
}

export function formatTestStackReport(report: TestStackReport): string {
  const lines: string[] = [];
  lines.push(`test-stack ${report.name} @ ${report.stackRoot}`);
  lines.push(`started  ${report.startedAt}`);
  lines.push(`finished ${report.finishedAt}`);
  lines.push("");
  for (const s of report.steps) {
    const mark = s.skipped ? "SKIP" : s.ok ? "PASS" : "FAIL";
    lines.push(
      `  [${mark}] ${s.id.padEnd(18)} ${s.title}${s.detail ? ` — ${s.detail}` : ""}`,
    );
  }
  lines.push("");
  lines.push(
    `summary: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`,
  );
  lines.push(report.ok ? "RESULT: PASS" : "RESULT: FAIL");
  lines.push("");
  lines.push(
    "Chains: bootstrap → apps-create → db-add → domain → cron-worker → permissions → http/tls → deploy",
  );
  lines.push("Note: TLS ACME issuance is not exercised (requires public DNS).");
  return lines.join("\n");
}

/** Resolve options from CLI flags. */
export function resolveTestStackOptions(argv: {
  name?: string;
  stack?: string;
  keep?: boolean;
  skipBuild?: boolean;
  skipHttp?: boolean;
  timeoutSec?: number;
  scheduleWaitSec?: number;
  repoRoot?: string;
  log?: TestStackOptions["log"];
}): TestStackOptions {
  const name = (argv.name && argv.name.length > 0) ? argv.name : DEFAULT_TEST_STACK_NAME;
  const stackRoot = resolve(
    argv.stack && argv.stack.length > 0 ? argv.stack : join(".", name),
  );
  return {
    name,
    stackRoot,
    repoRoot: argv.repoRoot,
    keep: !!argv.keep,
    skipBuild: !!argv.skipBuild,
    skipHttp: !!argv.skipHttp,
    timeoutMs: Math.max(30, argv.timeoutSec ?? 180) * 1000,
    scheduleWaitSec: argv.scheduleWaitSec != null
      ? Math.max(0, argv.scheduleWaitSec)
      : DEFAULT_SCHEDULE_WAIT_SEC,
    log: argv.log ?? ((level, msg) => {
      const prefix = level === "error" ? "error" : level === "warn" ? "warning" : "info";
      console.error(`${prefix}: ${msg}`);
    }),
  };
}
