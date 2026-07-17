import { runBackup, runRestore } from "../../services/mysql.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, type RunState, type YargsBuilder } from "../shared.ts";

export function registerBackupCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command(
      "backup",
      "Logical MySQL backup",
      (y: YargsBuilder) =>
        y
          .option("app", { type: "string", describe: "App slug" })
          .option("database", { type: "string", describe: "Single database" })
          .option("all", {
            type: "boolean",
            default: false,
            describe: "Backup all managed databases",
          })
          .option("gzip", { type: "boolean", default: false, describe: "gzip compress" })
          .option("none", {
            type: "boolean",
            default: false,
            describe: "No compression",
          }),
      bind(state, cmdBackup),
    )
    .command(
      "restore",
      "Logical MySQL restore",
      (y: YargsBuilder) =>
        y
          .option("file", { type: "string", demandOption: true, describe: "Dump path" })
          .option("app", { type: "string", demandOption: true })
          .option("target", {
            type: "string",
            demandOption: true,
            describe: "Target database name",
            alias: "database",
          })
          .option("replace", {
            type: "string",
            describe: "Exact target name confirmation for replacement",
          }),
      bind(state, cmdRestore),
    );
}

async function cmdBackup(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const scope = argv.all === true
    ? "all" as const
    : argv.database
    ? "database" as const
    : "app" as const;
  if (scope !== "all" && !argv.app) {
    ctx.log.error("usage: bento backup --app <app> [--database name] | --all");
    return 2;
  }
  try {
    const artifacts = await runBackup(ctx.platform, state, {
      scope,
      slug: argv.app,
      database: argv.database,
      compress: argv.gzip === true ? "gzip" : argv.none === true ? "none" : "zstd",
    });
    for (const a of artifacts) {
      ctx.log.info(`backup ${a.database} -> ${a.path} (${a.bytes} bytes)`);
    }
    return 0;
  } catch (e) {
    ctx.log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function cmdRestore(
  argv: ArgsWith<"file" | "app" | "target">,
  ctx: CliContext,
): Promise<number> {
  const { file, app, target } = argv;
  if (argv.replace && argv.replace !== target) {
    ctx.log.error("replace confirmation must exactly match target database name");
    return 10;
  }
  ctx.log.warn(
    "restore is not object-level atomic; a failed import can leave a partial destination",
  );
  const state = await ctx.store.load();
  await runRestore(ctx.platform, state, {
    file,
    slug: app,
    targetDatabase: target,
    replaceOriginal: argv.replace,
  });
  ctx.log.info(`restore completed into ${target}`);
  return 0;
}
