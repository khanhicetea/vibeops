import { materializeAppHome } from "../../services/app.ts";
import {
  deployWebhookInstructions,
  disableDeploy,
  drainDeploy,
  enableDeploy,
  loadQueue,
  rotateDeploySecret,
} from "../../services/deploy.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerDeployCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("deploy", "Webhook deploys for an app", (y: YargsBuilder) =>
      y
        .command(
          "enable <app>",
          "Enable webhook deploy for an app",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("app", { type: "string", demandOption: true })
                .option("fifo", {
                  type: "boolean",
                  default: false,
                  describe: "Use FIFO queue policy (default: latest)",
                }),
            ),
          bind(state, cmdDeployEnable),
        )
        .command(
          "disable <app>",
          "Disable webhook deploy",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("app", { type: "string", demandOption: true }),
            ),
          bind(state, cmdDeployDisable),
        )
        .command(
          "rotate <app>",
          "Rotate deploy HMAC secret (printed once)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("app", { type: "string", demandOption: true }),
            ),
          bind(state, cmdDeployRotate),
        )
        .command(
          "status <app>",
          "Show deploy queue status",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployStatus),
        )
        .command(
          "history <app>",
          "Show deploy history (alias of status)",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployStatus),
        )
        .command(
          "drain <app>",
          "Drain one queued deploy job",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployDrain),
        )
        .command(
          "instructions <app>",
          "Print webhook instructions",
          (y2: YargsBuilder) => y2.positional("app", { type: "string", demandOption: true }),
          bind(state, cmdDeployInstructions),
        )
        .demandCommand(
          1,
          "Specify a deploy subcommand: enable|disable|rotate|status|drain|instructions",
        )
        .recommendCommands());
}

async function cmdDeployEnable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const policy = argv.fifo === true ? "fifo" as const : "latest" as const;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const enabled = enableDeploy(state, { slug, queuePolicy: policy }, ctx.platform);
    await materializeAppHome(ctx.platform, enabled.state.apps[slug]!, false);
    await ctx.store.save(enabled.state);
    if (!noApply) {
      await ctx.render.apply(enabled.state, {
        reloadPlan: enabled.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return enabled;
  });
  ctx.log.out(deployWebhookInstructions(result.state.apps[slug]!, result.secret));
  return 0;
}

async function cmdDeployDisable(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const r = disableDeploy(state, slug, ctx.platform.clock.nowIso());
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
  ctx.log.info(`deploy disabled for ${slug}`);
  return 0;
}

async function cmdDeployRotate(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const r = rotateDeploySecret(state, slug, ctx.platform);
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
  ctx.log.out(result.secret);
  ctx.log.info("rotated deploy secret (shown once above)");
  return 0;
}

async function cmdDeployStatus(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
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

async function cmdDeployDrain(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const { app: slug } = argv;
  const state = await ctx.store.load();
  const app = state.apps[slug];
  if (!app) return 3;
  const home = ctx.platform.paths.appHome(slug);
  const job = await drainDeploy(ctx.platform, app, home);
  if (!job) ctx.log.info("no job drained");
  else ctx.log.info(`drained ${job.id} -> ${job.status}`);
  return 0;
}

async function cmdDeployInstructions(
  argv: ArgsWith<"app">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug } = argv;
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
