import {
  checkPermissions,
  formatPermReport,
  repairPermissions,
} from "../../services/permissions.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, type RunState, type YargsBuilder } from "../shared.ts";

export function registerPermissionsCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("permissions", "Filesystem permission check/repair", (y: YargsBuilder) =>
      y
        .command(
          "check <app>",
          "Check permission policy",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .option("recursive", { type: "boolean", default: false }),
          bind(state, cmdPermissionsCheck),
        )
        .command(
          "repair <app>",
          "Repair permission policy",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .option("recursive", { type: "boolean", default: false })
              .option("shallow", { type: "boolean", default: false })
              .option("dry-run", { type: "boolean", default: false }),
          bind(state, cmdPermissionsRepair),
        )
        .demandCommand(1, "Specify a permissions subcommand: check|repair")
        .recommendCommands());
}

async function cmdPermissionsCheck(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const report = await checkPermissions(ctx.platform, state, slug, {
    recursive: argv.recursive === true,
  });
  ctx.log.out(formatPermReport(report));
  return report.issues.length ? 1 : 0;
}

async function cmdPermissionsRepair(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const recursive = argv.recursive === true;
  const result = await repairPermissions(ctx.platform, state, slug, {
    dryRun: argv.dryRun === true,
    recursive,
    shallow: argv.shallow === true || !recursive,
  });
  for (const a of result.actions) ctx.log.info(a);
  ctx.log.out(formatPermReport(result.report));
  return 0;
}
