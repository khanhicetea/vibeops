import { addPhpVersion, listPhpVersions, removePhpVersion } from "../../services/php.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerPhpCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("php", "Manage PHP versions", (y: YargsBuilder) =>
      y
        .command(
          "list",
          "List PHP versions",
          () => {},
          bind(state, cmdPhpList),
        )
        .command(
          "add <version>",
          "Add a PHP version (fpm+runner+cli)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdPhpAdd),
        )
        .command(
          "remove <version>",
          "Remove an unused non-default PHP version",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2.positional("version", { type: "string", demandOption: true }),
            ),
          bind(state, cmdPhpRemove),
        )
        .demandCommand(1, "Specify a php subcommand: add|remove|list")
        .recommendCommands());
}

async function cmdPhpList(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const rows = listPhpVersions(state).map((v) => [
    v.version,
    v.service,
    `${v.service}-runner`,
    v.image,
    String(v.processCap),
  ]);
  ctx.log.out(printTable(["version", "fpm", "runner", "image", "cap"], rows));
  return 0;
}

async function cmdPhpAdd(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = addPhpVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply
      ? `added PHP ${version} (state only; run bento apply)`
      : `added PHP ${version} (fpm+runner+cli roles)`,
  );
  return 0;
}

async function cmdPhpRemove(argv: ArgsWith<"version">, ctx: CliContext): Promise<number> {
  const { version } = argv;
  const noApply = wantsNoApply(argv);
  await ctx.store.withExclusive(async (state) => {
    const next = removePhpVersion(state, version);
    await ctx.store.save(next);
    if (!noApply) {
      await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
    }
    return next;
  });
  ctx.log.info(
    noApply ? `removed PHP ${version} (state only; run bento apply)` : `removed PHP ${version}`,
  );
  return 0;
}
