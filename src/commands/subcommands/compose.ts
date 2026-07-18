import { assertSafeComposeArgs, composeArgs, resolveComposeFiles } from "../../services/compose.ts";
import { materializeDockerAssets } from "../../services/assets_materialize.ts";
import type { CliContext } from "../context.ts";
import type { CliArgs } from "../args.ts";
import { bind, type RunState, trailing, type YargsBuilder } from "../shared.ts";

export function registerComposeCommand(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command(
      "compose",
      "Safe docker compose wrapper (args after --)",
      (y: YargsBuilder) =>
        y
          .command(
            "files",
            "List merged Compose files in deterministic order",
            (y2: YargsBuilder) => y2,
            bind(state, cmdComposeFiles),
          )
          .option("print", {
            type: "boolean",
            default: false,
            describe: "Print full docker compose argv",
          }),
      bind(state, cmdCompose),
    );
}

async function cmdCompose(argv: CliArgs, ctx: CliContext): Promise<number> {
  const command = trailing(argv, 1).filter((a) => a !== "--print");
  const printOnly = argv.print === true || trailing(argv, 1).includes("--print");
  assertSafeComposeArgs(command);
  const state = await ctx.store.load();
  await materializeDockerAssets(
    ctx.platform,
    state.phpVersions.map((v) => String(v.version)),
  );
  await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
  const full = await composeArgs(ctx.platform, state, command);
  if (printOnly) {
    ctx.log.out(full.join(" "));
    return 0;
  }
  ctx.log.info(`running: docker compose ${command.join(" ")}`);
  const [cmd, ...cmdArgs] = full;
  const child = new Deno.Command(cmd!, {
    args: cmdArgs,
    cwd: ctx.stackRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  return status.code;
}

async function cmdComposeFiles(_argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const files = await resolveComposeFiles(ctx.platform, state);
  if (ctx.json) {
    ctx.log.out(JSON.stringify({ files }, null, 2));
  } else {
    ctx.log.out(
      "Compose files (deterministic order):\n" + files.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }
  return 0;
}
