import { addCronJob, listCronJobs, removeCronJob } from "../../services/cron.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import {
  bind,
  noApplyOption,
  type RunState,
  trailing,
  wantsNoApply,
  type YargsBuilder,
} from "../shared.ts";

export function registerCronCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("cron", "Scheduled jobs", (y: YargsBuilder) =>
      y
        .command(
          "list [app]",
          "List cron jobs",
          (y2: YargsBuilder) => y2.positional("app", { type: "string" }),
          bind(state, cmdCronList),
        )
        .command(
          "add",
          "Add a cron job (command after --)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("name", { type: "string", demandOption: true })
                .option("schedule", {
                  type: "string",
                  demandOption: true,
                  describe: "Cron expression",
                })
                .option("timezone", { type: "string" })
                .option("lock", { type: "string" })
                .option("timeout", { type: "number", describe: "Timeout seconds" })
                .option("cmd", {
                  type: "string",
                  describe: "Shell command string (supports redirects and pipelines)",
                }),
            ),
          bind(state, cmdCronAdd),
        )
        .command(
          "remove <app> <name>",
          "Remove a cron job",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .positional("name", { type: "string", demandOption: true }),
            ),
          bind(state, cmdCronRemove),
        )
        .demandCommand(1, "Specify a cron subcommand: add|remove|list")
        .recommendCommands());
}

async function cmdCronList(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app;
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

async function cmdCronAdd(
  argv: ArgsWith<"app" | "name" | "schedule">,
  ctx: CliContext,
): Promise<number> {
  const { app, name, schedule, cmd: shellCommand } = argv;
  const cmd = shellCommand !== undefined ? [shellCommand] : trailing(argv, 2);
  if (cmd.length === 0) {
    ctx.log.error(
      "usage: bento cron add --app <app> --name <name> --schedule '*/5 * * * *' -- <command...>",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = addCronJob(state, {
      app,
      name,
      schedule,
      command: cmd,
      commandMode: shellCommand !== undefined ? "shell" : "argv",
      timezone: argv.timezone,
      lock: argv.lock,
      timeoutSec: argv.timeout,
    }, ctx.platform);
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`added cron ${name} for ${app}`);
  return 0;
}

async function cmdCronRemove(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = removeCronJob(state, app, name, ctx.platform.clock.nowIso());
    await ctx.store.save(r.state);
    if (!noApply) {
      await ctx.render.apply(r.state, {
        reloadPlan: r.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return r;
  });
  ctx.log.info(`removed cron ${name}`);
  return 0;
}
