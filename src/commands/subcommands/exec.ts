import { composeArgs } from "../../services/compose.ts";
import { buildCliExec, cliRunComposeCommand } from "../../services/php.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith } from "../args.ts";
import { bind, type RunState, trailing, type YargsBuilder } from "../shared.ts";

export function registerExecCommand(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command(
      "exec <app>",
      "Ephemeral CLI as app identity (shell when no command; args after --)",
      (y: YargsBuilder) =>
        y
          .positional("app", { type: "string", demandOption: true })
          .option("workdir", {
            type: "string",
            describe: "Working directory inside app home",
          })
          .option("php", {
            type: "string",
            describe: "Managed PHP version override",
          })
          .option("print", {
            type: "boolean",
            default: false,
            describe: "Print compose argv instead of running",
          }),
      bind(state, cmdExec),
    );
}

async function cmdExec(argv: ArgsWith<"app">, ctx: CliContext): Promise<number> {
  const slug = argv.app;
  const cmd = trailing(argv, 1);
  return await runCliExec(ctx, {
    slug,
    argv: cmd,
    workdir: argv.workdir,
    phpVersionOverride: argv.php,
    printOnly: argv.print === true,
  });
}

/**
 * Ephemeral app CLI: interactive TTY attach for shells, inherited stdio for commands.
 * Uses the profile-gated `${phpService}-cli` service (F-06 / F-16).
 */
export async function runCliExec(
  ctx: CliContext,
  opts: {
    slug: string;
    argv: string[];
    workdir?: string;
    phpVersionOverride?: string;
    printOnly: boolean;
  },
): Promise<number> {
  const state = await ctx.store.load();
  let plan;
  try {
    plan = buildCliExec(ctx.platform, state, opts.slug, opts.argv, {
      workdir: opts.workdir,
      phpVersionOverride: opts.phpVersionOverride,
    });
  } catch (err) {
    ctx.log.error(err instanceof Error ? err.message : String(err));
    return 3;
  }

  let tty = false;
  try {
    tty = Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
  } catch {
    tty = false;
  }
  // --print always uses non-TTY form for stable scripted output.
  const composeCmd = cliRunComposeCommand(plan, { tty: !opts.printOnly && tty });
  const compose = await composeArgs(ctx.platform, state, composeCmd);

  if (opts.printOnly) {
    if (ctx.json) {
      ctx.log.out(JSON.stringify(
        {
          service: plan.service,
          profile: plan.profile,
          user: plan.user,
          workdir: plan.workdir,
          phpVersion: plan.phpVersion,
          argv: plan.argv,
          command: compose,
        },
        null,
        2,
      ));
    } else {
      ctx.log.out(compose.join(" "));
    }
    return 0;
  }

  // Interactive attach / inherited stdio — do not capture pipes (breaks shells).
  const [cmd, ...args] = compose;
  const child = new Deno.Command(cmd!, {
    args,
    cwd: ctx.stackRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  return status.code;
}
