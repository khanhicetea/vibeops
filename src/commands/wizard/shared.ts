import { isBentoError } from "../../domain/errors.ts";
import type { MysqlShellPlan } from "../../services/mysql.ts";
import { redact } from "../../ui/output.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";

export function pcDim(s: string): string {
  // local helper to avoid importing picocolors into every message site for dim-only
  return `\x1b[2m${s}\x1b[22m`;
}

export function handleError(ui: WizardUI, err: unknown): void {
  if (isBentoError(err)) {
    ui.error(redact(err.message), err.recovery ? `recovery: ${err.recovery}` : undefined);
    return;
  }
  ui.error(redact(err instanceof Error ? err.message : String(err)));
}

export async function ensureState(ui: WizardUI, ctx: CliContext): Promise<boolean> {
  try {
    await ctx.store.load();
    return true;
  } catch {
    ui.warn(
      "Stack not initialized",
      `Run Bootstrap → Initialize, or: bento --stack ${ctx.stackRoot} init`,
    );
    await ui.pause();
    return false;
  }
}

export async function openMysqlShell(
  ui: WizardUI,
  ctx: CliContext,
  plan: MysqlShellPlan,
  scriptable: string,
): Promise<void> {
  ui.blank();
  ui.info(
    `Attaching MySQL shell to ${plan.service} as ${plan.user}${
      plan.database ? ` · database=${plan.database}` : ""
    }`,
  );
  ui.message(pcDim(`scriptable: ${scriptable}`));
  ui.message(pcDim("Exit the MySQL client to return to the wizard."));
  ui.blank();

  if (plan.stage) {
    const staged = await ctx.platform.process.run(plan.stage.command, {
      cwd: ctx.stackRoot,
      stdin: plan.stage.stdin,
      timeoutMs: 15_000,
    });
    if (staged.code !== 0) {
      ui.error(
        "Failed to stage MySQL credentials",
        (staged.stderr || staged.stdout || "unknown error").trim(),
      );
      return;
    }
  }

  let exitCode = 1;
  try {
    const [cmd, ...args] = plan.open.command;
    const child = new Deno.Command(cmd!, {
      args,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = (await child.output()).code;
  } finally {
    if (plan.cleanup) {
      await ctx.platform.process.run(plan.cleanup.command, {
        cwd: ctx.stackRoot,
        timeoutMs: 10_000,
      }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    }
  }

  ui.blank();
  if (exitCode === 0) ui.success("MySQL shell closed", plan.service);
  else ui.warn(`MySQL shell exited ${exitCode}`, plan.service);
}
