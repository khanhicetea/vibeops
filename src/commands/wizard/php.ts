import { addPhpVersion, listPhpVersions } from "../../services/php.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError } from "./shared.ts";

export async function sectionPhp(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Manage PHP");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const state = await ctx.store.load();
    const versions = listPhpVersions(state);

    ui.clear();
    ui.header(
      "Manage PHP",
      `${versions.length} managed version${versions.length === 1 ? "" : "s"}`,
    );
    ui.table(
      ["version", "FPM service", "image", "process cap"],
      versions.map((version) => [
        version.version,
        version.service,
        version.image,
        String(version.processCap),
      ]),
    );
    ui.blank();
    const action = await ui.menu("PHP actions", [
      { label: "Add version", value: "add", hint: "creates FPM + runner + CLI" },
      {
        label: "Reload FPM",
        value: "reload",
        hint: "select a managed version",
        disabled: versions.length === 0,
      },
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
      const selected = await ui.menu(
        "PHP version to reload",
        versions.map((version) => ({
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
