import {
  applyAppDataPlane,
  capacityWarnings,
  deleteApp,
  materializeAppHome,
  provisionApp,
} from "../../services/app.ts";
import { loadRedisPassword } from "../../services/stack_env.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";
import { runCliExec } from "./exec.ts";

export function registerAppCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("app", "Provision and inspect applications", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List applications",
          () => {},
          bind(state, cmdAppList),
        )
        .command(
          "show <slug>",
          "Show one application (secrets redacted)",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppShow),
        )
        .command(
          "create <slug>",
          "Create or update an application",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("domain", {
                type: "string",
                demandOption: true,
                describe: "Primary domain",
              })
              .option("alias", {
                type: "string",
                describe: "Comma-separated domain aliases",
              })
              .option("docroot", {
                type: "string",
                describe: "Document root relative to app home",
              })
              .option("php", { type: "string", describe: "PHP version" })
              .option("fpm", { type: "string", describe: "FPM capacity profile" })
              .option("mysql", { type: "string", describe: "MySQL version/service" })
              .option("database", { type: "string", describe: "Initial database name" })
              .option("db", {
                type: "boolean",
                default: false,
                describe: "Create a database for the app",
              })
              .option("legacy", {
                type: "boolean",
                default: false,
                describe: "Allow direct PHP file execution",
              })
              .option("front", {
                type: "boolean",
                default: false,
                describe: "Force front-controller routing",
              })
              .option("access-log", {
                type: "boolean",
                default: false,
                describe: "Enable per-app access logs",
              })
              .option("no-apply", {
                type: "boolean",
                default: false,
                describe: "Skip render/apply after state mutation",
              })
              .option("skip-validate", {
                type: "boolean",
                default: false,
                describe: "Skip validators when applying",
              }),
          bind(state, cmdAppCreate),
        )
        .command(
          "update <slug>",
          "Update an application (same options as create)",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("domain", { type: "string", demandOption: true })
              .option("alias", { type: "string" })
              .option("docroot", { type: "string" })
              .option("php", { type: "string" })
              .option("fpm", { type: "string" })
              .option("mysql", { type: "string" })
              .option("database", { type: "string" })
              .option("db", { type: "boolean", default: false })
              .option("legacy", { type: "boolean", default: false })
              .option("front", { type: "boolean", default: false })
              .option("access-log", { type: "boolean", default: false })
              .option("no-apply", { type: "boolean", default: false })
              .option("skip-validate", { type: "boolean", default: false }),
          bind(state, cmdAppCreate),
        )
        .command(
          "delete <slug>",
          "Blocked: automatic app teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppDelete),
        )
        .command(
          "remove <slug>",
          "Blocked: automatic app teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("slug", { type: "string", demandOption: true }),
          bind(state, cmdAppDelete),
        )
        .command(
          "shell <slug>",
          "Attach interactive app CLI shell (ephemeral PHP identity)",
          (y2: YargsBuilder) =>
            y2
              .positional("slug", { type: "string", demandOption: true })
              .option("workdir", {
                type: "string",
                describe: "Working directory inside app home",
              })
              .option("php", {
                type: "string",
                describe: "Managed PHP version override",
              })
              .option("print", {
                type: "boolean",
                default: false,
                describe: "Print compose argv instead of attaching",
              }),
          bind(state, cmdAppShell),
        )
        .demandCommand(1, "Specify an app subcommand: create|list|show|update|shell")
        .recommendCommands());
}

async function cmdAppList(_argv: CliArgs, ctx: CliContext): Promise<number> {
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

async function cmdAppShow(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  const { slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) {
    ctx.log.error(`app not found: ${slug}`);
    return 3;
  }
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

async function cmdAppCreate(
  argv: ArgsWith<"slug" | "domain">,
  ctx: CliContext,
): Promise<number> {
  const { slug, domain } = argv;
  const aliases = argv.alias?.split(",").filter(Boolean) ?? [];
  const noApply = wantsNoApply(argv);
  const skipValidate = argv.skipValidate === true;
  const explicitDb = argv.db === true;
  const result = await ctx.store.withExclusive(async (state) => {
    const provisioned = provisionApp(ctx.platform, state, {
      slug,
      domain,
      aliases,
      documentRoot: argv.docroot,
      entrypointMode: argv.legacy === true
        ? "legacy"
        : argv.front === true
        ? "front-controller"
        : undefined,
      phpVersion: argv.php,
      fpmProfile: argv.fpm,
      mysqlVersion: argv.mysql,
      createDatabase: explicitDb,
      databaseName: argv.database,
      accessLog: argv.accessLog === true,
    });
    // Live MySQL/Redis side effects before recording state (explicit --db fails closed).
    const plane = await applyAppDataPlane(ctx.platform, provisioned.app, {
      explicitDatabase: explicitDb,
    });
    const redisShared = await loadRedisPassword(ctx.platform);
    await materializeAppHome(ctx.platform, provisioned.app, {
      recursivePerms: true,
      redisSharedPassword: redisShared,
    });
    await ctx.store.save(provisioned.state);
    if (!noApply) {
      await ctx.render.apply(provisioned.state, {
        reloadPlan: provisioned.reloadPlan,
        skipValidate,
        alreadyLocked: true,
      });
    }
    return { provisioned, plane };
  });
  ctx.log.info(
    `${
      result.provisioned.created ? "created" : "updated"
    } app ${result.provisioned.app.slug} uid=${result.provisioned.app.uid} domain=${result.provisioned.app.mainDomain}`,
  );
  for (const note of result.plane.deferredNotes) ctx.log.warn(note);
  for (const w of capacityWarnings(result.provisioned.state)) ctx.log.warn(w);
  return 0;
}

async function cmdAppDelete(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  deleteApp(await ctx.store.load(), argv.slug);
  return 10;
}

async function cmdAppShell(argv: ArgsWith<"slug">, ctx: CliContext): Promise<number> {
  // Interactive shell alias under `app shell` (no trailing command).
  return await runCliExec(ctx, {
    slug: argv.slug,
    argv: [],
    workdir: argv.workdir,
    phpVersionOverride: argv.php,
    printOnly: argv.print === true,
  });
}
