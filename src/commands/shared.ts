import type { Argv } from "yargs";
import { isBentoError } from "../domain/errors.ts";
import { BENTO_VERSION, DENO_TARGET_VERSION, versionBanner } from "../version.ts";
import { redact } from "../ui/output.ts";
import { type CliContext, contextFromArgv } from "./context.ts";
import type { CliArgs } from "./args.ts";

export type RunState = { code: number };
export type YargsBuilder = Argv<CliArgs>;

export class EarlyExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "EarlyExit";
  }
}

export function wantsNoApply(argv: CliArgs): boolean {
  return argv.noApply === true;
}

export function noApplyOption<T>(y: Argv<T>) {
  return y.option("no-apply", {
    type: "boolean",
    default: false,
    describe: "Mutate desired state only; skip render/apply (use `bento apply` later)",
  });
}

/** Drop command-path tokens from argv._ to recover passthrough args (after --). */
export function trailing(argv: CliArgs, drop: number): string[] {
  return argv._.slice(drop).map(String);
}

export function bind<A extends CliArgs>(
  state: RunState,
  handler: (argv: A, ctx: CliContext) => Promise<number>,
): (argv: A) => Promise<void> {
  return async (argv) => {
    const ctx = contextFromArgv(argv);
    try {
      state.code = await handler(argv, ctx);
    } catch (err) {
      if (err instanceof EarlyExit) {
        state.code = err.code;
        return;
      }
      if (isBentoError(err)) {
        ctx.log.error(redact(err.message));
        if (err.recovery) ctx.log.info(`recovery: ${err.recovery}`);
        state.code = err.exitCode;
        return;
      }
      ctx.log.error(redact(err instanceof Error ? err.message : String(err)));
      state.code = 1;
    }
  };
}

export function printVersion(): void {
  console.log(versionBanner());
  console.log(`bento ${BENTO_VERSION}`);
  console.log(`deno-target ${DENO_TARGET_VERSION}`);
}
