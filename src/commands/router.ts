/**
 * CLI command router backed by yargs + cliui.
 *
 * The router owns global parsing and error handling. Command definitions and
 * handlers live in `subcommands/`, grouped by CLI command.
 */

import yargs from "yargs";
import type { Argv } from "yargs";
import { isBentoError } from "../domain/errors.ts";
import { DEFAULT_TEST_STACK_NAME } from "../services/test_stack.ts";
import { redact } from "../ui/output.ts";
import { defaultStackRoot } from "./context.ts";
import { EarlyExit, printVersion, type RunState, type YargsBuilder } from "./shared.ts";
import { registerAppCommands } from "./subcommands/app.ts";
import { registerBackupCommands } from "./subcommands/backup.ts";
import { registerComposeCommand } from "./subcommands/compose.ts";
import { registerCoreCommands } from "./subcommands/core.ts";
import { registerCronCommands } from "./subcommands/cron.ts";
import { registerDeployCommands } from "./subcommands/deploy.ts";
import { registerExecCommand } from "./subcommands/exec.ts";
import { registerLogCommands } from "./subcommands/logs.ts";
import { registerMaintenanceCommands } from "./subcommands/maintenance.ts";
import { registerMysqlCommands } from "./subcommands/mysql.ts";
import { registerPermissionsCommands } from "./subcommands/permissions.ts";
import { registerPhpCommands } from "./subcommands/php.ts";
import { registerProxyCommands } from "./subcommands/proxy.ts";
import { registerStackCommands } from "./subcommands/stack.ts";
import { registerTemplateCommands } from "./subcommands/template.ts";
import { registerTlsCommands } from "./subcommands/tls.ts";
import { registerWorkerCommands } from "./subcommands/worker.ts";

function withGlobals<T>(y: Argv<T>) {
  return y
    .option("stack", {
      // Do not alias as --root; that flag belongs to `mysql shell --root`.
      type: "string",
      default: defaultStackRoot(),
      describe: "Stack root (mutable state); env BENTO_STACK_ROOT",
      global: true,
    })
    .option("json", {
      type: "boolean",
      default: false,
      describe: "Emit machine-readable diagnostics where supported",
      global: true,
    })
    .option("repo-root", {
      type: "string",
      describe: "Repository root override (tests / source mode)",
      global: true,
    })
    .parserConfiguration({
      "boolean-negation": false,
      "camel-case-expansion": true,
      "strip-dashed": true,
      "halt-at-non-option": false,
    });
}

function buildParser(state: RunState) {
  let parser = yargs()
    .scriptName("bento")
    .usage(
      "bento — single-server PHP application operations\n\nUsage: $0 [options] <command> [args]\n\nTip: $0 tui opens the interactive wizard.",
    )
    .strict()
    .help()
    .alias("h", "help")
    .version(false)
    .exitProcess(false)
    .recommendCommands()
    .wrap(Math.min(100, yargs().terminalWidth()))
    .epilogue("Environment:\n  BENTO_STACK_ROOT     Default stack root (mutable state)")
    .fail((msg: string | undefined, err: Error | undefined, failedYargs: Argv) => {
      if (err) throw err;
      if (msg) {
        console.error(`error: ${msg}`);
        console.error("");
        failedYargs.showHelp("error");
      }
      throw new EarlyExit(2);
    });

  parser = withGlobals(parser) as YargsBuilder;
  parser = registerCoreCommands(parser, state);
  parser = registerAppCommands(parser, state);
  parser = registerPhpCommands(parser, state);
  parser = registerMysqlCommands(parser, state);
  parser = registerProxyCommands(parser, state);
  parser = registerDeployCommands(parser, state);
  parser = registerCronCommands(parser, state);
  parser = registerWorkerCommands(parser, state);
  parser = registerExecCommand(parser, state);
  parser = registerComposeCommand(parser, state);
  parser = registerPermissionsCommands(parser, state);
  parser = registerBackupCommands(parser, state);
  parser = registerStackCommands(parser, state);
  parser = registerTlsCommands(parser, state);
  parser = registerLogCommands(parser, state);
  parser = registerTemplateCommands(parser, state);
  parser = registerMaintenanceCommands(parser, state);
  return parser.demandCommand(1, "Specify a command").recommendCommands();
}

export async function runCli(argv: string[]): Promise<number> {
  // Preserve historical short-circuits for version / bare help / test-stack flag.
  const tokens = stripGlobalTokens(argv);
  if (tokens[0] === "version" || tokens[0] === "--version" || tokens[0] === "-V") {
    printVersion();
    return 0;
  }
  if (
    tokens.length === 0 ||
    tokens[0] === "help" ||
    tokens[0] === "--help" ||
    tokens[0] === "-h"
  ) {
    buildParser({ code: 0 }).showHelp();
    return 0;
  }

  // Global --test-stack [name] alias (default name: testbento).
  const flagIdx = argv.findIndex((a) => a === "--test-stack" || a.startsWith("--test-stack="));
  if (flagIdx >= 0) {
    const flag = argv[flagIdx]!;
    let name = DEFAULT_TEST_STACK_NAME;
    if (flag.startsWith("--test-stack=") && flag.length > "--test-stack=".length) {
      name = flag.slice("--test-stack=".length);
    } else {
      const next = argv[flagIdx + 1];
      if (next && !next.startsWith("-")) name = next;
    }
    const rest = argv.filter((_, i) => {
      if (i === flagIdx) return false;
      if (!flag.includes("=") && i === flagIdx + 1 && argv[i] === name) return false;
      return true;
    });
    return await runCli(["test-stack", name, ...rest]);
  }

  const state: RunState = { code: 0 };
  const parser = buildParser(state);
  try {
    await parser.parseAsync(argv);
    return state.code;
  } catch (err) {
    if (err instanceof EarlyExit) return err.code;
    if (isBentoError(err)) {
      console.error(`error: ${redact(err.message)}`);
      if (err.recovery) console.error(`recovery: ${err.recovery}`);
      return err.exitCode;
    }
    console.error(`error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return 1;
  }
}

/** Remove known global flags so version/help short-circuits still work. */
function stripGlobalTokens(args: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stack" || a === "--root" || a === "--repo-root") {
      i++;
      continue;
    }
    if (a.startsWith("--stack=") || a.startsWith("--root=")) continue;
    if (a === "--test-stack") {
      rest.push(a);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        rest.push(next);
        i++;
      }
      continue;
    }
    if (a.startsWith("--test-stack=")) {
      rest.push(a);
      continue;
    }
    if (a === "--json") continue;
    rest.push(a);
  }
  return rest;
}
