import { exportStack, importStack } from "../../services/stack_transfer.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, type RunState, type YargsBuilder } from "../shared.ts";

export function registerStackCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser.command(
    "stack",
    "Export or import a complete stack and its database volumes",
    (y: YargsBuilder) =>
      y
        .command(
          "export <directory>",
          "Export stack.tar.gz, mysql.tar.gz, and redis.tar.gz",
          (y2: YargsBuilder) =>
            y2.positional("directory", {
              type: "string",
              demandOption: true,
              describe: "Empty destination directory outside the stack root",
            }),
          bind(state, cmdStackExport),
        )
        .command(
          "import <directory>",
          "Import the three archives into an empty stack root and start it",
          (y2: YargsBuilder) =>
            y2.positional("directory", {
              type: "string",
              demandOption: true,
              describe: "Directory containing stack.tar.gz, mysql.tar.gz, and redis.tar.gz",
            }),
          bind(state, cmdStackImport),
        )
        .demandCommand(1, "Specify a stack subcommand: export|import")
        .recommendCommands(),
  );
}

async function cmdStackExport(argv: ArgsWith<"directory">, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  ctx.log.warn("export contains application data, passwords, and private keys; store it securely");
  const result = await exportStack(ctx.platform, state, argv.directory);
  ctx.log.info(`stack exported to ${result.directory}`);
  for (const file of result.files) ctx.log.out(`  ${file}`);
  return 0;
}

async function cmdStackImport(argv: ArgsWith<"directory">, ctx: CliContext): Promise<number> {
  ctx.log.warn("import restores trusted archives and starts the destination stack");
  const result = await importStack(ctx.platform, argv.directory);
  ctx.log.info(`stack imported and started at ${result.directory}`);
  for (const volume of result.volumes) ctx.log.out(`  restored ${volume}`);
  return 0;
}
