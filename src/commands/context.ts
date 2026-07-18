import { resolve } from "@std/path";
import { describeReloadPlan } from "../domain/reload.ts";
import { createPlatform, type Platform } from "../platform/mod.ts";
import { StateStore } from "../services/state_store.ts";
import { RenderService } from "../services/render.ts";
import { createLogger, type Logger } from "../ui/output.ts";

export type CliContext = {
  platform: Platform;
  store: StateStore;
  render: RenderService;
  log: Logger;
  stackRoot: string;
  json: boolean;
};

export type GlobalFlags = {
  stackRoot: string;
  json?: boolean;
  repoRoot?: string;
};

export function defaultStackRoot(): string {
  return Deno.env.get("BENTO_STACK_ROOT") ?? Deno.env.get("BENTO_ROOT") ??
    "./bento";
}

export function createContext(flags: GlobalFlags): CliContext {
  const stackRoot = resolve(flags.stackRoot);
  const platform = createPlatform(stackRoot, flags.repoRoot);
  const log = createLogger({ json: flags.json });
  return {
    platform,
    store: new StateStore(platform),
    render: new RenderService(platform, (plan) => {
      log.success("Reload plan executed", describeReloadPlan(plan).join("\n"));
    }),
    log,
    stackRoot,
    json: !!flags.json,
  };
}

/** Build a CliContext from yargs-parsed global options. */
export function contextFromArgv(
  argv: { stack: string; json: boolean; repoRoot?: string },
): CliContext {
  return createContext({
    stackRoot: argv.stack,
    json: argv.json,
    ...(argv.repoRoot ? { repoRoot: argv.repoRoot } : {}),
  });
}
