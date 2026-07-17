import {
  generateAccessReport,
  isNginxOnlyReloadPlan,
  rotateAccessLog,
  setAppAccessLog,
} from "../../services/access_log.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerLogCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("logs", "Access log control and reports", (y: YargsBuilder) =>
      y
        .command(
          "access",
          "Per-app access logs (enable|disable|rotate|report)",
          (y2: YargsBuilder) =>
            y2
              .command(
                "enable",
                "Enable access logs for an app (nginx-only reload)",
                (y3: YargsBuilder) =>
                  noApplyOption(
                    y3.option("app", { type: "string", demandOption: true }),
                  ),
                bind(state, cmdLogsAccessEnable),
              )
              .command(
                "disable",
                "Disable access logs (preserves existing files)",
                (y3: YargsBuilder) =>
                  noApplyOption(
                    y3.option("app", { type: "string", demandOption: true }),
                  ),
                bind(state, cmdLogsAccessDisable),
              )
              .command(
                "rotate",
                "Rotate access log and reopen nginx (not config reload)",
                (y3: YargsBuilder) => y3.option("app", { type: "string", demandOption: true }),
                bind(state, cmdLogsAccessRotate),
              )
              .command(
                "report",
                "One-shot GoAccess HTML report or attached terminal dashboard",
                (y3: YargsBuilder) =>
                  y3
                    .option("app", { type: "string", demandOption: true })
                    .option("output", { type: "string", describe: "Report HTML path" })
                    .option("attach", {
                      alias: "terminal",
                      type: "boolean",
                      default: false,
                      describe: "Attach an interactive GoAccess terminal dashboard",
                    })
                    .option("dry-run", {
                      type: "boolean",
                      default: false,
                      describe: "Print planned docker run argv",
                    })
                    .conflicts("attach", "output"),
                bind(state, cmdLogsAccessReport),
              )
              .demandCommand(1, "Specify: enable|disable|rotate|report")
              .recommendCommands(),
          () => {
            /* nested */
          },
        )
        .demandCommand(1, "Specify a logs subcommand: access")
        .recommendCommands());
}

// --- access logs (F-23) ------------------------------------------------------

async function cmdLogsAccessEnable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, true);
}

async function cmdLogsAccessDisable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  return await mutateAccessLog(argv, ctx, false);
}

async function mutateAccessLog(
  argv: ArgsWith<"app">,
  ctx: CliContext,
  enabled: boolean,
): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const mutation = setAppAccessLog(
      state,
      slug,
      enabled,
      ctx.platform.clock.nowIso(),
      ctx.platform,
    );
    if (!isNginxOnlyReloadPlan(mutation.reloadPlan)) {
      throw new Error("access log mutation must be nginx-only");
    }
    await ctx.store.save(mutation.state);
    if (!noApply) {
      await ctx.render.apply(mutation.state, {
        reloadPlan: mutation.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return mutation;
  });
  ctx.log.info(
    enabled
      ? `access logs enabled for ${slug}`
      : `access logs disabled for ${slug} (existing files preserved at ${result.preservedLogPath})`,
  );
  return 0;
}

async function cmdLogsAccessRotate(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const result = await rotateAccessLog(ctx.platform, state, slug);
  // Assert reopen path (not nginx -s reload).
  const joined = result.plan.reopenCommand.join(" ");
  if (!joined.includes("reopen") || joined.includes("reload")) {
    ctx.log.error("internal: rotate plan must use nginx -s reopen");
    return 1;
  }
  ctx.log.info(
    result.rotated
      ? `rotated ${result.plan.logPath} -> ${result.plan.rotatedPath}`
      : `no active log file at ${result.plan.logPath}; reopen ${
        result.reopened ? "ok" : "skipped (nginx unavailable)"
      }`,
  );
  return 0;
}

async function cmdLogsAccessReport(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const dryRun = argv.dryRun === true;
  const attach = argv.attach === true;
  const result = await generateAccessReport(ctx.platform, state, slug, {
    output: argv.output,
    dryRun,
    attach,
  });
  if (dryRun) {
    if (ctx.json) ctx.log.out(JSON.stringify(result, null, 2));
    else ctx.log.out(result.command.join(" "));
    return 0;
  }
  if (attach) {
    let tty = false;
    try {
      tty = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
    } catch {
      tty = false;
    }
    if (!tty) {
      ctx.log.error(
        "GoAccess attach requires an interactive terminal; use HTML mode or --dry-run.",
      );
      return 2;
    }

    ctx.log.info("attaching GoAccess terminal; press q to return");
    const [cmd, ...args] = result.command;
    const child = new Deno.Command(cmd!, {
      args,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    return (await child.status).code;
  }
  ctx.log.info(`report written to ${result.reportPath}`);
  return 0;
}
