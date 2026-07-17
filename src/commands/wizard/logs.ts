import {
  generateAccessReport,
  rotateAccessLog,
  setAppAccessLog,
} from "../../services/access_log.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { handleError, pcDim } from "./shared.ts";

export async function sectionLogs(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Access logs: ${slug}`);

  while (true) {
    const action = await ui.menu("Access logs", [
      { label: "Enable", value: "enable", hint: "nginx-only reload" },
      { label: "Disable", value: "disable", hint: "preserves files" },
      { label: "Rotate + reopen", value: "rotate" },
      { label: "Open GoAccess terminal", value: "report-terminal", hint: "attach container" },
      { label: "Generate GoAccess HTML report", value: "report-html" },
    ]);
    if (!action) return;

    try {
      if (action === "enable" || action === "disable") {
        const enabled = action === "enable";
        await ctx.store.withExclusive(async (state) => {
          const mutation = setAppAccessLog(
            state,
            slug,
            enabled,
            ctx.platform.clock.nowIso(),
            ctx.platform,
          );
          await ctx.store.save(mutation.state);
          await ctx.render.apply(mutation.state, {
            reloadPlan: mutation.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return mutation;
        });
        ui.success(
          enabled ? `Access logs enabled for ${slug}` : `Access logs disabled for ${slug}`,
        );
      } else if (action === "rotate") {
        const state = await ctx.store.load();
        const result = await rotateAccessLog(ctx.platform, state, slug);
        ui.success(
          result.rotated
            ? `Rotated to ${result.plan.rotatedPath}`
            : "No active log; reopen attempted",
        );
      } else if (action === "report-terminal") {
        const state = await ctx.store.load();
        const plan = await generateAccessReport(ctx.platform, state, slug, {
          attach: true,
        });
        ui.blank();
        ui.info(`Attaching GoAccess to ${slug}'s access log.`);
        ui.message(pcDim("Press q in GoAccess to return to the wizard."));
        ui.blank();

        const [cmd, ...args] = plan.command;
        const child = new Deno.Command(cmd!, {
          args,
          cwd: ctx.stackRoot,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).spawn();
        const code = (await child.status).code;
        ui.blank();
        if (code === 0) ui.success("GoAccess terminal closed");
        else ui.warn(`GoAccess exited ${code}`);
      } else if (action === "report-html") {
        const state = await ctx.store.load();
        const report = await generateAccessReport(ctx.platform, state, slug);
        ui.success("GoAccess report generated", report.reportPath);
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}
