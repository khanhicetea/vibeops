import { registerHostMaintenance, runStackMaintenance } from "../../services/maintenance.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, type RunState, type YargsBuilder } from "../shared.ts";

export function registerMaintenanceCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("maintenance", "Host/stack maintenance", (y: YargsBuilder) =>
      y
        .command(
          "run",
          "On-demand log retention (in-runner logrotate is separate)",
          (y2: YargsBuilder) =>
            y2.option("retain-days", {
              type: "number",
              default: 14,
              describe: "Delete rotated logs older than N days",
            }),
          bind(state, cmdMaintenanceRun),
        )
        .command(
          "register",
          "Register host cron entry (preserves unrelated crontab lines)",
          (y2: YargsBuilder) =>
            y2
              .option("schedule", {
                type: "string",
                default: "15 3 * * *",
                describe: "Cron schedule",
              })
              .option("bin", {
                type: "string",
                describe: "bento executable path (default: bento on PATH)",
              }),
          bind(state, cmdMaintenanceRegister),
        )
        .command(
          "unregister",
          "Remove host cron entry (preserves unrelated crontab lines)",
          () => {},
          bind(state, cmdMaintenanceUnregister),
        )
        .demandCommand(1, "Specify a maintenance subcommand: run|register|unregister")
        .recommendCommands());
}

// --- maintenance (product §6.10) ---------------------------------------------

async function cmdMaintenanceRun(argv: ArgsWith<"retainDays">, ctx: CliContext): Promise<number> {
  const { retainDays } = argv;
  const result = await runStackMaintenance(ctx.platform, { retainDays });
  for (const n of result.notes) ctx.log.info(n);
  if (ctx.json) {
    ctx.log.out(JSON.stringify(result, null, 2));
  } else {
    ctx.log.info(`removed ${result.removed.length} file(s)`);
    for (const p of result.removed) ctx.log.out(`  removed ${p}`);
  }
  return 0;
}

async function cmdMaintenanceRegister(argv: CliArgs, ctx: CliContext): Promise<number> {
  const result = await registerHostMaintenance(ctx.platform, {
    action: "install",
    schedule: argv.schedule,
    bentoBin: argv.bin,
    stackRoot: ctx.stackRoot,
  });
  ctx.log.info(
    result.action === "installed"
      ? "registered host maintenance cron (unrelated entries preserved)"
      : "host maintenance cron already registered",
  );
  return 0;
}

async function cmdMaintenanceUnregister(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const result = await registerHostMaintenance(ctx.platform, {
    action: "remove",
    stackRoot: ctx.stackRoot,
  });
  ctx.log.info(
    result.action === "removed"
      ? "unregistered host maintenance cron (unrelated entries preserved)"
      : "no host maintenance cron entry found",
  );
  return 0;
}
