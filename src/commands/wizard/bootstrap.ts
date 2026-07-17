import { describeReloadPlan } from "../../domain/reload.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError } from "./shared.ts";

export async function sectionBootstrap(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Bootstrap", ctx.stackRoot);
  const action = await ui.menu("Bootstrap actions", [
    { label: "Initialize empty desired state", value: "init", hint: "bento init" },
    { label: "Render generated config (no reload)", value: "render", hint: "bento render" },
    { label: "Apply (render + validate + reload)", value: "apply", hint: "bento apply" },
    {
      label: "Render only (skip service signals)",
      value: "apply-ro",
      hint: "bento apply --render-only",
    },
  ]);
  if (!action) return;

  if (action === "init") {
    const force = await ui.confirm("Overwrite existing state if present?", { defaultYes: false });
    try {
      const state = await ctx.store.init(force);
      ui.success(
        "Initialized",
        `state=${ctx.platform.paths.paths.stateFile}\nphp=${state.defaults.phpVersion} mysql=${state.defaults.mysqlVersion}`,
      );
    } catch (err) {
      handleError(ui, err);
    }
  } else if (action === "render") {
    if (!(await ensureState(ui, ctx))) return;
    const state = await ctx.store.load();
    const result = await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
    ui.success(`Rendered ${result.files.length} files`, "render-only, no service signals");
  } else if (action === "apply" || action === "apply-ro") {
    if (!(await ensureState(ui, ctx))) return;
    const renderOnly = action === "apply-ro";
    const skipValidate = renderOnly
      ? true
      : await ui.confirm("Skip config validators?", { defaultYes: false });
    const state = await ctx.store.load();
    const result = await ctx.render.apply(state, { renderOnly, skipValidate });
    ui.success(
      `Applied ${result.files.length} files`,
      `reload=${describeReloadPlan(result.reloadPlan).join(",") || "none"}${
        renderOnly ? " (render-only)" : ""
      }`,
    );
  }
  await ui.pause();
}
