import {
  detectTemplateDrift,
  formatDriftWarnings,
  prepareCustomTemplate,
  returnToUpstreamTemplate,
  selectCustomTemplate,
  type TemplateKind,
} from "../../services/customization.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { openEditor } from "../editor.ts";
import { handleError } from "./shared.ts";

export async function sectionTemplate(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Templates: ${slug}`);

  while (true) {
    const action = await ui.menu("Templates", [
      { label: "Create / edit custom template", value: "select", hint: "opens your editor" },
      { label: "Return to upstream", value: "return" },
      { label: "Check upstream drift", value: "drift" },
    ]);
    if (!action) return;

    try {
      if (action === "drift") {
        const state = await ctx.store.load();
        const drifts = (await detectTemplateDrift(ctx.platform, state)).filter((drift) =>
          drift.slug === slug
        );
        if (drifts.length === 0) ui.info("No custom templates");
        else {
          ui.table(
            ["kind", "status", "source"],
            drifts.map((d) => [
              d.kind,
              d.drifted ? "DRIFT" : "ok",
              d.sourcePath,
            ]),
          );
          for (const w of formatDriftWarnings(drifts)) ui.warn(w);
        }
        await ui.pause();
        continue;
      }

      const kind = await ui.menu<TemplateKind>("Template kind", [
        { label: "Nginx vhost", value: "vhost" },
        { label: "PHP-FPM pool", value: "pool" },
      ]);
      if (!kind) continue;

      if (action === "select") {
        const prepared = await prepareCustomTemplate(
          ctx.platform,
          await ctx.store.load(),
          slug,
          kind,
        );
        ui.info(
          prepared.created
            ? `Created from upstream: ${prepared.path}`
            : `Editing: ${prepared.path}`,
        );
        await openEditor(prepared.path);

        const result = await ctx.store.withExclusive(async (state) => {
          const selected = await selectCustomTemplate(ctx.platform, state, {
            slug,
            kind,
            sourcePath: prepared.path,
            copy: false,
          });
          await ctx.store.save(selected.state);
          await ctx.render.apply(selected.state, {
            reloadPlan: selected.reloadPlan,
            skipValidate: false,
            alreadyLocked: true,
          });
          return selected;
        });
        ui.success(`Activated custom ${kind}`, result.recordedPath);
      } else if (action === "return") {
        const result = await ctx.store.withExclusive(async (state) => {
          const returned = returnToUpstreamTemplate(
            state,
            slug,
            kind,
            ctx.platform.clock.nowIso(),
          );
          await ctx.store.save(returned.state);
          await ctx.render.apply(returned.state, {
            reloadPlan: returned.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return returned;
        });
        ui.success(
          `Returned ${kind} to upstream`,
          result.preservedPath ? `custom source preserved at ${result.preservedPath}` : undefined,
        );
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}
