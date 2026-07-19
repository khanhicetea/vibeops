import { createProxy, deleteProxy } from "../../services/proxy.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerProxyCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("proxy", "Reverse-proxy sites", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List reverse proxies",
          () => {},
          bind(state, cmdProxyList),
        )
        .command(
          "create <name>",
          "Create a reverse-proxy site",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .positional("name", { type: "string", demandOption: true })
                .option("domain", {
                  type: "string",
                  demandOption: true,
                  describe: "Primary domain",
                })
                .option("upstream", {
                  type: "string",
                  array: true,
                  demandOption: true,
                  describe: "Upstream URL; repeat for multiple servers",
                })
                .option("alias", {
                  type: "string",
                  describe: "Comma-separated domain aliases",
                }),
            ),
          bind(state, cmdProxyCreate),
        )
        .command(
          "delete <name>",
          "Blocked: automatic proxy teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("name", { type: "string", demandOption: true }),
          bind(state, cmdProxyDelete),
        )
        .command(
          "remove <name>",
          "Blocked: automatic proxy teardown is unavailable",
          (y2: YargsBuilder) => y2.positional("name", { type: "string", demandOption: true }),
          bind(state, cmdProxyDelete),
        )
        .demandCommand(1, "Specify a proxy subcommand: create|list")
        .recommendCommands());
}

async function cmdProxyList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = Object.values(state.proxies).map((p) => [
    p.name,
    p.mainDomain,
    p.upstreams.join(", "),
    p.tls.kind,
  ]);
  ctx.log.out(printTable(["name", "domain", "upstream", "tls"], rows));
  return 0;
}

async function cmdProxyCreate(
  argv: ArgsWith<"name" | "domain" | "upstream">,
  ctx: CliContext,
): Promise<number> {
  const { name, domain, upstream } = argv;
  const upstreams = Array.isArray(upstream) ? upstream : [upstream];
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const result = createProxy(state, {
      name,
      domain,
      upstreams,
      aliases: argv.alias?.split(",") ?? [],
    }, ctx.platform.clock.nowIso());
    await ctx.store.save(result.state);
    if (!noApply) {
      await ctx.render.apply(result.state, {
        reloadPlan: result.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return result;
  });
  ctx.log.info(
    noApply ? `created proxy ${name} (state only; run bento apply)` : `created proxy ${name}`,
  );
  return 0;
}

async function cmdProxyDelete(argv: ArgsWith<"name">, ctx: CliContext): Promise<number> {
  deleteProxy(await ctx.store.load(), argv.name);
  return 10;
}
