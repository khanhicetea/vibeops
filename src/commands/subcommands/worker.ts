import {
  addWorker,
  buildWorkerControlPlan,
  controlWorker,
  inspectWorker,
  listWorkers,
  removeWorker,
  type WorkerControlAction,
} from "../../services/worker.ts";
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

export function registerWorkerCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("worker", "Long-running workers", (y: YargsBuilder) =>
      y
        .command(
          "list [app]",
          "List workers",
          (y2: YargsBuilder) => y2.positional("app", { type: "string" }),
          bind(state, cmdWorkerList),
        )
        .command(
          "add",
          "Add a worker (command after --)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("name", { type: "string", demandOption: true })
                .option("cmd", {
                  type: "string",
                  describe: "Command string (prefer -- argv form)",
                }),
            ),
          bind(state, cmdWorkerAdd),
        )
        .command(
          "remove <app> <name>",
          "Remove a worker",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .positional("name", { type: "string", demandOption: true }),
            ),
          bind(state, cmdWorkerRemove),
        )
        .command(
          "start <app> <name>",
          "Start one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerStart),
        )
        .command(
          "stop <app> <name>",
          "Stop one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerStop),
        )
        .command(
          "restart <app> <name>",
          "Restart one worker (scoped supervisorctl)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerRestart),
        )
        .command(
          "inspect <app> <name>",
          "Inspect one worker (supervisor status)",
          (y2: YargsBuilder) =>
            y2
              .positional("app", { type: "string", demandOption: true })
              .positional("name", { type: "string", demandOption: true }),
          bind(state, cmdWorkerInspect),
        )
        .demandCommand(
          1,
          "Specify a worker subcommand: add|remove|list|start|stop|restart|inspect",
        )
        .recommendCommands());
}

async function cmdWorkerList(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const app = argv.app;
  const rows = listWorkers(state, app).map((w) => [
    w.app,
    w.name,
    w.command.join(" "),
    w.enabled ? "yes" : "no",
  ]);
  ctx.log.out(printTable(["app", "name", "command", "enabled"], rows));
  return 0;
}

async function cmdWorkerAdd(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const cmd = argv.cmd?.split(/\s+/).filter(Boolean) ?? trailing(argv, 2);
  if (cmd.length === 0) {
    ctx.log.error(
      "usage: bento worker add --app <app> --name <name> -- <command...>",
    );
    return 2;
  }
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = addWorker(state, {
      app,
      name,
      command: cmd,
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
  ctx.log.info(`added worker ${name} for ${app}`);
  return 0;
}

async function cmdWorkerRemove(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = removeWorker(state, app, name, ctx.platform.clock.nowIso());
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
  ctx.log.info(`removed worker ${name}`);
  return 0;
}

async function cmdWorkerControl(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
  action: WorkerControlAction,
): Promise<number> {
  const { app, name } = argv;
  const state = await ctx.store.load();
  const plan = buildWorkerControlPlan(state, app, name, action);
  const result = await controlWorker(ctx.platform, plan);
  if (result.stdout) ctx.log.out(result.stdout.trimEnd());
  if (result.stderr && result.code !== 0) {
    ctx.log.error(result.stderr.trim());
  }
  if (result.code === 0) {
    ctx.log.info(`${action} ${plan.program} on ${plan.runnerService}`);
  }
  return result.code === 0 ? 0 : 8;
}

async function cmdWorkerStart(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "start");
}
async function cmdWorkerStop(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "stop");
}
async function cmdWorkerRestart(argv: ArgsWith<"app" | "name">, ctx: CliContext): Promise<number> {
  return await cmdWorkerControl(argv, ctx, "restart");
}
async function cmdWorkerInspect(
  argv: ArgsWith<"app" | "name">,
  ctx: CliContext,
): Promise<number> {
  const { app, name } = argv;
  const state = await ctx.store.load();
  const result = await inspectWorker(ctx.platform, state, app, name);
  if (ctx.json) {
    ctx.log.out(JSON.stringify(
      {
        app: result.worker.app,
        name: result.worker.name,
        program: result.plan.program,
        runner: result.plan.runnerService,
        command: result.worker.command,
        enabled: result.worker.enabled,
        supervisor: result.stdout.trim(),
      },
      null,
      2,
    ));
  } else {
    ctx.log.out(
      [
        `worker ${result.worker.app}/${result.worker.name}`,
        `  program: ${result.plan.program}`,
        `  runner:  ${result.plan.runnerService}`,
        `  command: ${result.worker.command.join(" ")}`,
        `  enabled: ${result.worker.enabled ? "yes" : "no"}`,
        `  status:  ${result.stdout.trim() || result.stderr.trim() || "(no output)"}`,
      ].join("\n"),
    );
  }
  return result.code === 0 ? 0 : 8;
}
