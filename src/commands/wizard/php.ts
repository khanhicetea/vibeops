import { addPhpVersion, listPhpVersions } from "../../services/php.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError } from "./shared.ts";

export async function sectionPhp(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Manage PHP");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("PHP", [
      { label: "Add version", value: "add", hint: "creates FPM + runner + CLI" },
      { label: "Reload FPM", value: "reload", hint: "select a managed version" },
    ]);
    if (!action) return;

    if (action === "add") {
      const version = await ui.prompt("PHP version (e.g. 8.3)", { required: true });
      if (!version) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const next = addPhpVersion(state, version);
          await ctx.store.save(next);
          await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
          return next;
        });
        ui.success(`Added PHP ${version}`, "FPM + runner + CLI roles");
      } catch (err) {
        handleError(ui, err);
      }
    } else {
      const state = await ctx.store.load();
      const selected = await ui.menu(
        "PHP version to reload",
        listPhpVersions(state).map((version) => ({
          label: version.version,
          value: version.service,
          hint: `${version.service} · ${version.image}`,
        })),
      );
      if (!selected) continue;
      try {
        await ctx.render.apply(state, {
          reloadPlan: {
            nginx: false,
            phpFpm: new Set([selected]),
            phpRunner: new Set(),
          },
          skipValidate: false,
        });
        ui.success(`Reloaded FPM service ${selected}`);
      } catch (err) {
        handleError(ui, err);
      }
    }
    await ui.pause();
  }
}
