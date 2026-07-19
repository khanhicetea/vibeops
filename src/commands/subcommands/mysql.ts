import { materializeAppHome } from "../../services/app.ts";
import {
  addMysqlVersion,
  assertShellPlanSecretsOffArgv,
  buildMysqlShellPlan,
  createAppDatabaseLive,
  listMysqlVersions,
  queryDatabaseSizes,
  queryProcesslist,
  removeMysqlVersion,
  resolveMysqlServices,
} from "../../services/mysql.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "../../services/stack_env.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerMysqlCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("mysql", "Manage MySQL (add-only versions)", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List MySQL versions",
          () => {},
          bind(state, cmdMysqlList),
        )
        .command(
          "add <version>",
          "Add a MySQL version service",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdMysqlAdd),
        )
        .command(
          "remove <version>",
          "Blocked: MySQL version removal is unavailable",
          (y2: YargsBuilder) => y2.positional("version", { type: "string", demandOption: true }),
          bind(state, cmdMysqlRemove),
        )
        .command(
          "db <app> <database>",
          "Record a namespaced database for an app",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("database", { type: "string", demandOption: true }),
          bind(state, cmdMysqlDb),
        )
        .command(
          "shell",
          "Open MySQL shell (protected option file; never host argv)",
          (y2: YargsBuilder) =>
            y2
              .option("root", {
                type: "boolean",
                default: false,
                describe: "Connect as MySQL root",
              })
              .option("app", {
                type: "string",
                describe: "Connect as app MySQL user",
              })
              .option("service", {
                type: "string",
                describe: "MySQL service/version (root mode)",
              })
              .option("database", {
                type: "string",
                describe: "Default database",
              })
              .option("print", {
                type: "boolean",
                default: false,
                describe: "Print planned argv (secrets redacted) instead of opening",
              }),
          bind(state, cmdMysqlShell),
        )
        .command(
          "size",
          "Show database sizes (no secrets)",
          (y2: YargsBuilder) =>
            y2
              .option("app", { type: "string", describe: "Limit to one app's databases" })
              .option("service", {
                type: "string",
                describe: "MySQL service/version",
              }),
          bind(state, cmdMysqlSize),
        )
        .command(
          "processlist",
          "Show active MySQL processes (no secrets)",
          (y2: YargsBuilder) =>
            y2.option("service", {
              type: "string",
              describe: "MySQL service/version",
            }).option("app", {
              type: "string",
              describe: "Resolve service from app",
            }),
          bind(state, cmdMysqlProcesslist),
        )
        .demandCommand(1, "Specify a mysql subcommand: add|list|db|shell|size|processlist")
        .recommendCommands());
}

async function cmdMysqlList(_argv: CliArgs, ctx: CliContext): Promise<number> {
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

async function cmdMysqlAdd(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = addMysqlVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply ? `added MySQL ${version} (state only; run bento apply)` : `added MySQL ${version}`,
  );
  return 0;
}

async function cmdMysqlRemove(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  removeMysqlVersion(await ctx.store.load(), argv.version);
  return 10;
}

async function cmdMysqlDb(
  argv: ArgsWith<"app" | "database">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, database: dbName } = argv;
  await ctx.store.withExclusive(async (state) => {
    const rootPassword = await requireMysqlRootPassword(ctx.platform);
    // Fail before recording when MySQL is unavailable or grants fail.
    const next = await createAppDatabaseLive(
      ctx.platform,
      state,
      slug,
      dbName,
      rootPassword,
    );
    const app = next.apps[slug]!;
    const redisShared = await loadRedisPassword(ctx.platform);
    await materializeAppHome(ctx.platform, app, {
      recursivePerms: false,
      redisSharedPassword: redisShared,
    });
    await ctx.store.save(next);
    return next;
  });
  ctx.log.info(`created database ${dbName} for app ${slug}`);
  return 0;
}

async function cmdMysqlShell(
  argv: ArgsWith<"root" | "print">,
  ctx: CliContext,
): Promise<number> {
  const asRoot = argv.root;
  const appSlug = argv.app ?? "";
  if (asRoot === Boolean(appSlug)) {
    ctx.log.error("usage: bento mysql shell --root [--service mysql84] | --app <slug>");
    return 2;
  }
  const state = await ctx.store.load();
  const database = argv.database;
  const printOnly = argv.print;

  let plan;
  if (asRoot) {
    const services = resolveMysqlServices(state, {
      service: argv.service,
    });
    const service = services[0];
    if (!service) {
      ctx.log.error("no MySQL service managed");
      return 3;
    }
    plan = buildMysqlShellPlan(ctx.platform, { kind: "root", service }, {
      database,
      interactive: !printOnly,
    });
  } else {
    const app = state.apps[appSlug];
    if (!app) {
      ctx.log.error(`app not found: ${appSlug}`);
      return 3;
    }
    plan = buildMysqlShellPlan(ctx.platform, { kind: "app", app }, {
      database,
      interactive: !printOnly,
    });
    assertShellPlanSecretsOffArgv(plan, [app.mysqlPassword]);
  }

  if (printOnly) {
    if (ctx.json) {
      ctx.log.out(JSON.stringify(
        {
          service: plan.service,
          user: plan.user,
          database: plan.database,
          stage: plan.stage?.command,
          open: plan.open.command,
          cleanup: plan.cleanup?.command,
        },
        null,
        2,
      ));
    } else {
      if (plan.stage) ctx.log.out(`stage: ${plan.stage.command.join(" ")}`);
      ctx.log.out(`open:  ${plan.open.command.join(" ")}`);
      if (plan.cleanup) ctx.log.out(`cleanup: ${plan.cleanup.command.join(" ")}`);
    }
    return 0;
  }

  // App sessions stage their option file; root uses the generated read-only file.
  if (plan.stage) {
    const staged = await ctx.platform.process.run(plan.stage.command, {
      cwd: ctx.stackRoot,
      stdin: plan.stage.stdin,
      timeoutMs: 15_000,
    });
    if (staged.code !== 0) {
      ctx.log.error(
        `failed to stage mysql option file: ${(staged.stderr || staged.stdout || "").trim()}`,
      );
      return 8;
    }
  }

  try {
    // Interactive attach — CLI layer may use Deno.Command with inherited stdio.
    const [cmd, ...args] = plan.open.command;
    const child = new Deno.Command(cmd!, {
      args,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.output();
    return status.code;
  } finally {
    if (plan.cleanup) {
      await ctx.platform.process.run(plan.cleanup.command, {
        cwd: ctx.stackRoot,
        timeoutMs: 10_000,
      }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    }
  }
}

async function cmdMysqlSize(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service,
    app: argv.app,
  });
  const allRows: Array<{
    service: string;
    database: string;
    tables: string;
    dataSize: string;
    indexSize: string;
    totalSize: string;
  }> = [];
  for (const service of services) {
    let databases: string[] = [];
    if (argv.app) {
      const app = state.apps[argv.app];
      databases = app?.databases.map((d) => d.name) ?? [];
    }
    const { rows } = await queryDatabaseSizes(ctx.platform, service, rootPassword, databases);
    for (const r of rows) {
      allRows.push({ service, ...r });
    }
  }
  if (ctx.json) {
    ctx.log.out(JSON.stringify(allRows, null, 2));
  } else {
    ctx.log.out(
      printTable(
        ["service", "database", "tables", "data_size", "index_size", "total_size"],
        allRows.map((r) => [
          r.service,
          r.database,
          r.tables,
          r.dataSize,
          r.indexSize,
          r.totalSize,
        ]),
      ),
    );
  }
  return 0;
}

async function cmdMysqlProcesslist(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rootPassword = await requireMysqlRootPassword(ctx.platform);
  const services = resolveMysqlServices(state, {
    service: argv.service,
    app: argv.app,
  });
  for (const service of services) {
    const { stdout } = await queryProcesslist(ctx.platform, service, rootPassword);
    if (services.length > 1) ctx.log.out(`-- ${service} --`);
    ctx.log.out(stdout.trimEnd() || "(no processes)");
  }
  return 0;
}
