import { resolve } from "@std/path";
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

export function createContext(flags: GlobalFlags): CliContext {
  const stackRoot = resolve(flags.stackRoot);
  const platform = createPlatform(stackRoot, flags.repoRoot);
  return {
    platform,
    store: new StateStore(platform),
    render: new RenderService(platform),
    log: createLogger({ json: flags.json }),
    stackRoot,
    json: !!flags.json,
  };
}

export function parseGlobalFlags(args: string[]): {
  flags: GlobalFlags;
  rest: string[];
} {
  let stackRoot = Deno.env.get("BENTO_STACK_ROOT") ?? Deno.env.get("BENTO_ROOT") ??
    "./.bento-stack";
  let json = false;
  let repoRoot: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--stack" || a === "--root") {
      stackRoot = args[++i] ?? stackRoot;
    } else if (a.startsWith("--stack=")) {
      stackRoot = a.slice("--stack=".length);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--repo-root") {
      repoRoot = args[++i];
    } else {
      // Preserve "--" so subcommands can separate argv payloads.
      rest.push(a);
    }
  }
  return { flags: { stackRoot, json, repoRoot }, rest };
}
