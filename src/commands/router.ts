/**
 * CLI command router. Scriptable operations; interactive wizard is optional convenience.
 */

import { isBentoError } from "../domain/errors.ts";
import { BENTO_VERSION, DENO_TARGET_VERSION, versionBanner } from "../version.ts";
import { describeReloadPlan } from "../domain/reload.ts";
import { type CliContext, createContext, parseGlobalFlags } from "./context.ts";
import { capacityWarnings, materializeAppHome, provisionApp } from "../services/app.ts";
import { addPhpVersion, buildCliExec, listPhpVersions, removePhpVersion } from "../services/php.ts";
import {
  addMysqlVersion,
  createAppDatabase,
  listMysqlVersions,
  removeMysqlVersion,
  rotateAppPassword,
  runBackup,
  runRestore,
} from "../services/mysql.ts";
import { createProxy } from "../services/proxy.ts";
import {
  deployWebhookInstructions,
  disableDeploy,
  drainDeploy,
  enableDeploy,
  loadQueue,
  rotateDeploySecret,
} from "../services/deploy.ts";
import { addCronJob, listCronJobs, removeCronJob } from "../services/cron.ts";
import { addWorker, listWorkers, removeWorker } from "../services/worker.ts";
import { buildStatus, formatStatus } from "../services/status.ts";
import { checkPermissions, formatPermReport, repairPermissions } from "../services/permissions.ts";
import { assertSafeComposeArgs, composeArgs } from "../services/compose.ts";
import { printTable, redact } from "../ui/output.ts";
import type { TlsMode } from "../domain/state.ts";

export async function runCli(argv: string[]): Promise<number> {
  const { flags, rest } = parseGlobalFlags(argv);
  if (rest[0] === "version" || rest[0] === "--version" || rest[0] === "-V") {
    console.log(versionBanner());
    console.log(`bento ${BENTO_VERSION}`);
    console.log(`deno-target ${DENO_TARGET_VERSION}`);
    return 0;
  }
  if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
    printHelp();
    return 0;
  }

  const ctx = createContext(flags);
  const [cmd, ...args] = rest;

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(ctx, args);
      case "render":
        return await cmdRender(ctx, args);
      case "apply":
        return await cmdApply(ctx, args);
      case "status":
        return await cmdStatus(ctx, args);
      case "app":
        return await cmdApp(ctx, args);
      case "php":
        return await cmdPhp(ctx, args);
      case "mysql":
        return await cmdMysql(ctx, args);
      case "proxy":
        return await cmdProxy(ctx, args);
      case "deploy":
        return await cmdDeploy(ctx, args);
      case "cron":
        return await cmdCron(ctx, args);
      case "worker":
        return await cmdWorker(ctx, args);
      case "exec":
        return await cmdExec(ctx, args);
      case "compose":
        return await cmdCompose(ctx, args);
      case "permissions":
        return await cmdPermissions(ctx, args);
      case "backup":
        return await cmdBackup(ctx, args);
      case "restore":
        return await cmdRestore(ctx, args);
      case "tls":
        return await cmdTls(ctx, args);
      default:
        ctx.log.error(`unknown command: ${cmd}`);
        printHelp();
        return 2;
    }
  } catch (err) {
    if (isBentoError(err)) {
      ctx.log.error(redact(err.message));
      if (err.recovery) ctx.log.info(`recovery: ${err.recovery}`);
      return err.exitCode;
    }
    ctx.log.error(redact(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

function printHelp(): void {
  console.log(`bento — single-server PHP application operations

Usage: bento [--stack PATH] <command> [args]

Commands:
  init                 Initialize empty desired state
  render               Render generated config (no reload)
  apply                Render, validate, and reload targeted services
  status               Show stack/app/runtime status
  app create|list|show Provision and inspect applications
  php add|remove|list  Manage PHP versions
  mysql add|list|db|password  Manage MySQL (add-only versions)
  proxy create|list    Reverse-proxy sites
  deploy enable|disable|rotate|status|drain|instructions
  cron add|remove|list Scheduled jobs
  worker add|remove|list  Long-running workers
  exec <app> -- <cmd>  Ephemeral CLI as app identity
  compose -- <args>    Safe docker compose wrapper
  permissions check|repair
  backup|restore       Logical MySQL backup/restore
  tls set              Set TLS mode for app or proxy
  version              Show bento and deno target versions

Environment:
  BENTO_STACK_ROOT     Default stack root (mutable state)
`);
}

async function cmdInit(ctx: CliContext, args: string[]): Promise<number> {
  const force = args.includes("--force");
  const state = await ctx.store.init(force);
  ctx.log.info(`initialized state at ${ctx.platform.paths.paths.stateFile}`);
  ctx.log.info(
    `defaults: php=${state.defaults.phpVersion} mysql=${state.defaults.mysqlVersion}`,
  );
  return 0;
}

async function cmdRender(ctx: CliContext, _args: string[]): Promise<number> {
  const state = await ctx.store.load();
  const result = await ctx.render.apply(state, {
    renderOnly: true,
    skipValidate: true,
  });
  ctx.log.info(
    `rendered ${result.files.length} files (render-only, no service signals)`,
  );
  if (ctx.json) {
    ctx.log.out(JSON.stringify({ files: result.managedManifest }, null, 2));
  }
  return 0;
}

async function cmdApply(ctx: CliContext, args: string[]): Promise<number> {
  const renderOnly = args.includes("--render-only");
  const skipValidate = args.includes("--skip-validate");
  const state = await ctx.store.load();
  const result = await ctx.render.apply(state, { renderOnly, skipValidate });
  ctx.log.info(
    `applied ${result.files.length} files; reload=${
      describeReloadPlan(result.reloadPlan).join(",")
    }${renderOnly ? " (render-only)" : ""}`,
  );
  return 0;
}

async function cmdStatus(ctx: CliContext, _args: string[]): Promise<number> {
  const state = await ctx.store.load();
  const report = await buildStatus(ctx.platform, state);
  if (ctx.json) ctx.log.out(JSON.stringify(report, null, 2));
  else ctx.log.out(formatStatus(report));
  return 0;
}

async function cmdApp(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const rows = Object.values(state.apps)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((a) => [
        a.slug,
        String(a.uid),
        a.mainDomain,
        a.phpVersion,
        a.fpmProfile,
        a.tls.kind,
        a.mysqlService,
      ]);
    ctx.log.out(
      printTable(
        ["slug", "uid", "domain", "php", "fpm", "tls", "mysql"],
        rows,
      ),
    );
    return 0;
  }
  if (sub === "show") {
    const slug = args[1];
    if (!slug) {
      ctx.log.error("usage: bento app show <slug>");
      return 2;
    }
    const state = await ctx.store.load();
    const app = state.apps[slug];
    if (!app) {
      ctx.log.error(`app not found: ${slug}`);
      return 3;
    }
    // Do not print passwords
    const safe = {
      ...app,
      mysqlPassword: "***",
      redis: {
        ...app.redis,
        password: app.redis.password ? "***" : undefined,
        aclPassword: app.redis.aclPassword ? "***" : undefined,
      },
      deploy: {
        ...app.deploy,
        hmacSecret: app.deploy.hmacSecret ? "***" : undefined,
      },
    };
    ctx.log.out(JSON.stringify(safe, null, 2));
    return 0;
  }
  if (sub === "create" || sub === "update") {
    const opts = parseKeyArgs(args.slice(1));
    const slug = opts._[0] ?? opts.slug;
    const domain = opts.domain;
    if (!slug || !domain) {
      ctx.log.error(
        "usage: bento app create <slug> --domain <domain> [--php 8.5] [--fpm small] [--docroot public] [--legacy] [--db] [--alias a,b]",
      );
      return 2;
    }
    const aliases = opts.alias ? String(opts.alias).split(",").filter(Boolean) : [];
    const result = await ctx.store.withExclusive(async (state) => {
      const provisioned = provisionApp(ctx.platform, state, {
        slug: String(slug),
        domain: String(domain),
        aliases,
        documentRoot: opts.docroot ? String(opts.docroot) : undefined,
        entrypointMode: opts.legacy ? "legacy" : opts.front ? "front-controller" : undefined,
        phpVersion: opts.php ? String(opts.php) : undefined,
        fpmProfile: opts.fpm ? String(opts.fpm) : undefined,
        mysqlVersion: opts.mysql ? String(opts.mysql) : undefined,
        createDatabase: opts.db === true || opts.db === "true",
        databaseName: opts.database ? String(opts.database) : undefined,
        accessLog: opts["access-log"] === true,
      });
      await materializeAppHome(ctx.platform, provisioned.app, true);
      await ctx.store.save(provisioned.state);
      if (!opts["no-apply"]) {
        await ctx.render.apply(provisioned.state, {
          reloadPlan: provisioned.reloadPlan,
          skipValidate: opts["skip-validate"] === true,
          alreadyLocked: true,
        });
      }
      return provisioned;
    });
    ctx.log.info(
      `${
        result.created ? "created" : "updated"
      } app ${result.app.slug} uid=${result.app.uid} domain=${result.app.mainDomain}`,
    );
    for (const w of capacityWarnings(result.state)) ctx.log.warn(w);
    return 0;
  }
  ctx.log.error("usage: bento app create|list|show");
  return 2;
}

async function cmdPhp(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const rows = listPhpVersions(state).map((v) => [
      v.version,
      v.service,
      `${v.service}-runner`,
      v.image,
      String(v.processCap),
    ]);
    ctx.log.out(printTable(["version", "fpm", "runner", "image", "cap"], rows));
    return 0;
  }
  if (sub === "add") {
    const version = args[1];
    if (!version) {
      ctx.log.error("usage: bento php add <version>");
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const next = addPhpVersion(state, version);
      await ctx.store.save(next);
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
      return next;
    });
    ctx.log.info(`added PHP ${version} (fpm+runner+cli roles)`);
    return 0;
  }
  if (sub === "remove") {
    const version = args[1];
    if (!version) {
      ctx.log.error("usage: bento php remove <version>");
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const next = removePhpVersion(state, version);
      await ctx.store.save(next);
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
      return next;
    });
    ctx.log.info(`removed PHP ${version}`);
    return 0;
  }
  ctx.log.error("usage: bento php add|remove|list");
  return 2;
}

async function cmdMysql(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const rows = listMysqlVersions(state).map((v) => [
      v.version,
      v.service,
      v.volume,
      v.image,
    ]);
    ctx.log.out(printTable(["version", "service", "volume", "image"], rows));
    return 0;
  }
  if (sub === "add") {
    const version = args[1];
    if (!version) {
      ctx.log.error("usage: bento mysql add <version>");
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const next = addMysqlVersion(state, version);
      await ctx.store.save(next);
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
      return next;
    });
    ctx.log.info(`added MySQL ${version}`);
    return 0;
  }
  if (sub === "remove") {
    removeMysqlVersion(await ctx.store.load(), args[1] ?? "");
    return 10;
  }
  if (sub === "db") {
    const slug = args[1];
    const dbName = args[2];
    if (!slug || !dbName) {
      ctx.log.error("usage: bento mysql db <app> <database>");
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const next = createAppDatabase(state, slug, dbName, ctx.platform.clock.nowIso());
      await ctx.store.save(next);
      // SQL side effect would run here when docker available; state records intent.
      return next;
    });
    ctx.log.info(`recorded database ${dbName} for app ${slug}`);
    return 0;
  }
  if (sub === "password") {
    const slug = args[1];
    if (!slug) {
      ctx.log.error("usage: bento mysql password <app>");
      return 2;
    }
    const result = await ctx.store.withExclusive(async (state) => {
      const rotated = rotateAppPassword(ctx.platform, state, slug);
      await ctx.store.save(rotated.state);
      return rotated;
    });
    // Print password once to stdout only (operator secret channel)
    ctx.log.out(result.password);
    ctx.log.info(`rotated MySQL password for ${slug} (shown once above)`);
    return 0;
  }
  ctx.log.error("usage: bento mysql add|list|db|password");
  return 2;
}

async function cmdProxy(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const rows = Object.values(state.proxies).map((p) => [
      p.name,
      p.mainDomain,
      p.upstream,
      p.tls.kind,
    ]);
    ctx.log.out(printTable(["name", "domain", "upstream", "tls"], rows));
    return 0;
  }
  if (sub === "create") {
    const opts = parseKeyArgs(args.slice(1));
    const name = opts._[0] ?? opts.name;
    if (!name || !opts.domain || !opts.upstream) {
      ctx.log.error(
        "usage: bento proxy create <name> --domain <domain> --upstream http://127.0.0.1:3000",
      );
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const result = createProxy(state, {
        name: String(name),
        domain: String(opts.domain),
        upstream: String(opts.upstream),
        aliases: opts.alias ? String(opts.alias).split(",") : [],
      }, ctx.platform.clock.nowIso());
      await ctx.store.save(result.state);
      await ctx.render.apply(result.state, {
        reloadPlan: result.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return result;
    });
    ctx.log.info(`created proxy ${name}`);
    return 0;
  }
  ctx.log.error("usage: bento proxy create|list");
  return 2;
}

async function cmdDeploy(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "enable") {
    const slug = args[1];
    if (!slug) {
      ctx.log.error("usage: bento deploy enable <app>");
      return 2;
    }
    const policy = args.includes("--fifo") ? "fifo" as const : "latest" as const;
    const result = await ctx.store.withExclusive(async (state) => {
      const enabled = enableDeploy(state, { slug, queuePolicy: policy }, ctx.platform);
      await materializeAppHome(ctx.platform, enabled.state.apps[slug]!, false);
      await ctx.store.save(enabled.state);
      await ctx.render.apply(enabled.state, {
        reloadPlan: enabled.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return enabled;
    });
    ctx.log.out(deployWebhookInstructions(result.state.apps[slug]!, result.secret));
    return 0;
  }
  if (sub === "disable") {
    const slug = args[1];
    if (!slug) return 2;
    await ctx.store.withExclusive(async (state) => {
      const r = disableDeploy(state, slug, ctx.platform.clock.nowIso());
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.info(`deploy disabled for ${slug}`);
    return 0;
  }
  if (sub === "rotate") {
    const slug = args[1];
    if (!slug) return 2;
    const result = await ctx.store.withExclusive(async (state) => {
      const r = rotateDeploySecret(state, slug, ctx.platform);
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.out(result.secret);
    ctx.log.info("rotated deploy secret (shown once above)");
    return 0;
  }
  if (sub === "status" || sub === "history") {
    const slug = args[1];
    if (!slug) return 2;
    const state = await ctx.store.load();
    const app = state.apps[slug];
    if (!app) {
      ctx.log.error(`app not found: ${slug}`);
      return 3;
    }
    const home = ctx.platform.paths.appHome(slug);
    const queue = await loadQueue(ctx.platform, home);
    if (ctx.json) ctx.log.out(JSON.stringify(queue, null, 2));
    else {
      const rows = queue.jobs.map((j) => [
        j.id,
        j.status,
        j.receivedAt,
        j.finishedAt ?? "",
        j.error ?? "",
      ]);
      ctx.log.out(printTable(["id", "status", "received", "finished", "error"], rows));
    }
    return 0;
  }
  if (sub === "drain") {
    const slug = args[1];
    if (!slug) return 2;
    const state = await ctx.store.load();
    const app = state.apps[slug];
    if (!app) return 3;
    const home = ctx.platform.paths.appHome(slug);
    const job = await drainDeploy(ctx.platform, app, home);
    if (!job) ctx.log.info("no job drained");
    else ctx.log.info(`drained ${job.id} -> ${job.status}`);
    return 0;
  }
  if (sub === "instructions") {
    const slug = args[1];
    if (!slug) return 2;
    const state = await ctx.store.load();
    const app = state.apps[slug];
    if (!app?.deploy.enabled) {
      ctx.log.error("deploy not enabled");
      return 3;
    }
    ctx.log.out(
      deployWebhookInstructions(app, app.deploy.hmacSecret ? "<stored in state>" : ""),
    );
    return 0;
  }
  ctx.log.error("usage: bento deploy enable|disable|rotate|status|drain|instructions");
  return 2;
}

async function cmdCron(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const app = args[1];
    const rows = listCronJobs(state, app).map((j) => [
      j.app,
      j.name,
      j.schedule,
      j.command.join(" "),
      j.enabled ? "yes" : "no",
    ]);
    ctx.log.out(printTable(["app", "name", "schedule", "command", "enabled"], rows));
    return 0;
  }
  if (sub === "add") {
    const opts = parseKeyArgs(args.slice(1));
    const app = opts.app ?? opts._[0];
    const name = opts.name ?? opts._[1];
    const schedule = opts.schedule;
    const command = opts._.slice(app && name && opts._[0] === app ? 2 : 0);
    // also support --cmd
    const cmd = opts.cmd
      ? String(opts.cmd).split(/\s+/)
      : args.includes("--")
      ? args.slice(args.indexOf("--") + 1)
      : command;
    if (!app || !name || !schedule || cmd.length === 0) {
      ctx.log.error(
        "usage: bento cron add --app <app> --name <name> --schedule '*/5 * * * *' -- <command...>",
      );
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const r = addCronJob(state, {
        app: String(app),
        name: String(name),
        schedule: String(schedule),
        command: cmd.map(String),
        timezone: opts.timezone ? String(opts.timezone) : undefined,
        lock: opts.lock ? String(opts.lock) : undefined,
        timeoutSec: opts.timeout ? Number(opts.timeout) : undefined,
      }, ctx.platform);
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.info(`added cron ${name} for ${app}`);
    return 0;
  }
  if (sub === "remove") {
    const app = args[1];
    const name = args[2];
    if (!app || !name) return 2;
    await ctx.store.withExclusive(async (state) => {
      const r = removeCronJob(state, app, name, ctx.platform.clock.nowIso());
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.info(`removed cron ${name}`);
    return 0;
  }
  ctx.log.error("usage: bento cron add|remove|list");
  return 2;
}

async function cmdWorker(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "list") {
    const state = await ctx.store.load();
    const app = args[1];
    const rows = listWorkers(state, app).map((w) => [
      w.app,
      w.name,
      w.command.join(" "),
      w.enabled ? "yes" : "no",
    ]);
    ctx.log.out(printTable(["app", "name", "command", "enabled"], rows));
    return 0;
  }
  if (sub === "add") {
    const opts = parseKeyArgs(args.slice(1));
    const app = opts.app;
    const name = opts.name;
    const cmd = args.includes("--")
      ? args.slice(args.indexOf("--") + 1)
      : opts.cmd
      ? String(opts.cmd).split(/\s+/)
      : [];
    if (!app || !name || cmd.length === 0) {
      ctx.log.error(
        "usage: bento worker add --app <app> --name <name> -- <command...>",
      );
      return 2;
    }
    await ctx.store.withExclusive(async (state) => {
      const r = addWorker(state, {
        app: String(app),
        name: String(name),
        command: cmd.map(String),
      }, ctx.platform);
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.info(`added worker ${name} for ${app}`);
    return 0;
  }
  if (sub === "remove") {
    const app = args[1];
    const name = args[2];
    if (!app || !name) return 2;
    await ctx.store.withExclusive(async (state) => {
      const r = removeWorker(state, app, name, ctx.platform.clock.nowIso());
      await ctx.store.save(r.state);
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
      return r;
    });
    ctx.log.info(`removed worker ${name}`);
    return 0;
  }
  ctx.log.error("usage: bento worker add|remove|list");
  return 2;
}

async function cmdExec(ctx: CliContext, args: string[]): Promise<number> {
  const slug = args[0];
  if (!slug) {
    ctx.log.error("usage: bento exec <app> -- <command...>");
    return 2;
  }
  const dash = args.indexOf("--");
  const cmd = dash >= 0 ? args.slice(dash + 1) : args.slice(1);
  const state = await ctx.store.load();
  const plan = buildCliExec(ctx.platform, state, slug, cmd.length ? cmd : ["bash"]);
  const compose = await composeArgs(ctx.platform, state, [
    "run",
    "--rm",
    "-u",
    plan.user,
    "-w",
    plan.workdir,
    ...Object.entries(plan.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    plan.service,
    ...plan.argv,
  ]);
  if (args.includes("--print")) {
    ctx.log.out(compose.join(" "));
    return 0;
  }
  const result = await ctx.platform.process.run(compose, {
    cwd: ctx.stackRoot,
  });
  if (result.stdout) await Deno.stdout.write(new TextEncoder().encode(result.stdout));
  if (result.stderr) await Deno.stderr.write(new TextEncoder().encode(result.stderr));
  return result.code;
}

async function cmdCompose(ctx: CliContext, args: string[]): Promise<number> {
  const dash = args.indexOf("--");
  const raw = dash >= 0 ? args.slice(dash + 1) : args;
  const printOnly = raw.includes("--print") || args.includes("--print");
  const command = raw.filter((a) => a !== "--print");
  assertSafeComposeArgs(command);
  const state = await ctx.store.load();
  // Ensure docker build contexts + helpers exist before compose build/up
  const { materializeDockerAssets } = await import("../services/assets_materialize.ts");
  await materializeDockerAssets(
    ctx.platform,
    state.phpVersions.map((v) => String(v.version)),
  );
  // Ensure generated compose files exist (re-render if missing or stale fragments)
  const baseCompose = `${ctx.platform.paths.paths.composeDir}/docker-compose.base.yml`;
  if (!(await ctx.platform.fs.exists(baseCompose))) {
    await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
  } else {
    // Re-render so build: contexts are present after upgrades
    await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
  }
  const full = await composeArgs(ctx.platform, state, command);
  if (printOnly) {
    ctx.log.out(full.join(" "));
    return 0;
  }
  ctx.log.info(`running: docker compose ${command.join(" ")}`);
  // Stream compose output (build logs) directly to the terminal
  const [cmd, ...cmdArgs] = full;
  const child = new Deno.Command(cmd!, {
    args: cmdArgs,
    cwd: ctx.stackRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  return status.code;
}

async function cmdPermissions(ctx: CliContext, args: string[]): Promise<number> {
  const sub = args[0];
  const slug = args[1];
  if (!sub || !slug) {
    ctx.log.error("usage: bento permissions check|repair <app> [--recursive] [--dry-run]");
    return 2;
  }
  const state = await ctx.store.load();
  if (sub === "check") {
    const report = await checkPermissions(ctx.platform, state, slug, {
      recursive: args.includes("--recursive"),
    });
    ctx.log.out(formatPermReport(report));
    return report.issues.length ? 1 : 0;
  }
  if (sub === "repair") {
    const result = await repairPermissions(ctx.platform, state, slug, {
      dryRun: args.includes("--dry-run"),
      recursive: args.includes("--recursive"),
      shallow: args.includes("--shallow") || !args.includes("--recursive"),
    });
    for (const a of result.actions) ctx.log.info(a);
    ctx.log.out(formatPermReport(result.report));
    return 0;
  }
  return 2;
}

async function cmdBackup(ctx: CliContext, args: string[]): Promise<number> {
  const opts = parseKeyArgs(args);
  const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
  if (!rootPassword) {
    ctx.log.error("MYSQL_ROOT_PASSWORD must be set in the environment for backup");
    return 9;
  }
  const state = await ctx.store.load();
  const scope = opts.all ? "all" as const : opts.database ? "database" as const : "app" as const;
  if (scope !== "all" && !opts.app) {
    ctx.log.error("usage: bento backup --app <app> [--database name] | --all");
    return 2;
  }
  try {
    const artifacts = await runBackup(ctx.platform, state, {
      scope,
      slug: opts.app ? String(opts.app) : undefined,
      database: opts.database ? String(opts.database) : undefined,
      compress: opts.gzip ? "gzip" : opts.none ? "none" : "zstd",
    }, rootPassword);
    for (const a of artifacts) {
      ctx.log.info(`backup ${a.database} -> ${a.path} (${a.bytes} bytes)`);
    }
    return 0;
  } catch (e) {
    ctx.log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function cmdRestore(ctx: CliContext, args: string[]): Promise<number> {
  const opts = parseKeyArgs(args);
  const file = opts.file ?? opts._[0];
  const app = opts.app;
  const target = opts.target ?? opts.database;
  if (!file || !app || !target) {
    ctx.log.error(
      "usage: bento restore --file <path> --app <app> --target <db> [--replace <exact-name>]",
    );
    return 2;
  }
  if (opts.replace && String(opts.replace) !== String(target)) {
    ctx.log.error("replace confirmation must exactly match target database name");
    return 10;
  }
  ctx.log.warn(
    "restore is not object-level atomic; a failed import can leave a partial destination",
  );
  const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
  if (!rootPassword) {
    ctx.log.error("MYSQL_ROOT_PASSWORD must be set");
    return 9;
  }
  const state = await ctx.store.load();
  await runRestore(ctx.platform, state, {
    file: String(file),
    slug: String(app),
    targetDatabase: String(target),
    replaceOriginal: opts.replace ? String(opts.replace) : undefined,
  }, rootPassword);
  ctx.log.info(`restore completed into ${target}`);
  return 0;
}

async function cmdTls(ctx: CliContext, args: string[]): Promise<number> {
  // bento tls set --app x --mode acme|boot|external ...
  if (args[0] !== "set") {
    ctx.log.error("usage: bento tls set --app <app>|--proxy <name> --mode boot|acme|external");
    return 2;
  }
  const opts = parseKeyArgs(args.slice(1));
  const mode = String(opts.mode ?? "");
  let tls: TlsMode;
  if (mode === "boot") tls = { kind: "boot" };
  else if (mode === "acme") {
    tls = { kind: "acme", ...(opts.email ? { email: String(opts.email) } : {}) };
  } else if (mode === "external") {
    if (!opts.cert || !opts.key) {
      ctx.log.error("external TLS requires --cert and --key");
      return 2;
    }
    tls = { kind: "external", certPath: String(opts.cert), keyPath: String(opts.key) };
  } else {
    ctx.log.error("mode must be boot|acme|external");
    return 2;
  }

  await ctx.store.withExclusive(async (state) => {
    const now = ctx.platform.clock.nowIso();
    let next = state;
    if (opts.app) {
      const slug = String(opts.app);
      const app = state.apps[slug];
      if (!app) throw new Error(`app not found: ${slug}`);
      // HTTPS redirect only for real-certificate modes
      next = {
        ...state,
        apps: {
          ...state.apps,
          [slug]: { ...app, tls, updatedAt: now },
        },
        updatedAt: now,
      };
    } else if (opts.proxy) {
      const name = String(opts.proxy);
      const proxy = state.proxies[name];
      if (!proxy) throw new Error(`proxy not found: ${name}`);
      next = {
        ...state,
        proxies: {
          ...state.proxies,
          [name]: { ...proxy, tls, updatedAt: now },
        },
        updatedAt: now,
      };
    } else {
      throw new Error("provide --app or --proxy");
    }
    await ctx.store.save(next);
    await ctx.render.apply(next, {
      reloadPlan: { nginx: true, phpFpm: new Set(), phpRunner: new Set() },
      skipValidate: true,
      alreadyLocked: true,
    });
    return next;
  });
  ctx.log.info(`tls mode set to ${mode}`);
  return 0;
}

function parseKeyArgs(
  args: string[],
): { _: string[] } & Record<string, string | boolean | string[]> {
  const out: { _: string[] } & Record<string, string | boolean | string[]> = {
    _: [] as string[],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      if (body.includes("=")) {
        const [k, v] = body.split("=", 2);
        out[k!] = v!;
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          out[body] = next;
          i++;
        } else {
          out[body] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}
