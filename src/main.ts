/**
 * Bento control plane entrypoint.
 * Supports direct `deno run` and `deno compile` distributions.
 */

import { runCli } from "./commands/router.ts";

if (import.meta.main) {
  const code = await runCli(Deno.args);
  Deno.exit(code);
}

export { runCli };
