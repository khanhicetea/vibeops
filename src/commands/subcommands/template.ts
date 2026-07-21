import {
  detectTemplateDrift,
  formatDriftWarnings,
  prepareCustomTemplate,
  returnToUpstreamTemplate,
  selectCustomTemplate,
} from "../../services/customization.ts";
import { printTable } from "../../ui/output.ts";
import type { CliContext } from "../context.ts";
import type { ArgsWith, CliArgs } from "../args.ts";
import { openEditor } from "../editor.ts";
import { bind, noApplyOption, type RunState, wantsNoApply, type YargsBuilder } from "../shared.ts";

export function registerTemplateCommands(parser: YargsBuilder, state: RunState): YargsBuilder {
  return parser
    .command("template", "App vhost/pool template customization", (y: YargsBuilder) =>
      y
        .command(
          "select",
          "Create or edit a custom vhost or pool template",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("kind", {
                  type: "string",
                  demandOption: true,
                  choices: ["vhost", "pool"] as const,
                })
                .option("source", {
                  type: "string",
                  describe: "Import an existing template instead of opening an editor",
                })
                .option("no-copy", {
                  type: "boolean",
                  default: false,
                  describe: "Record source path in-place (do not copy into custom/)",
                }),
            ),
          bind(state, cmdTemplateSelect),
        )
        .command(
          "return",
          "Return to upstream template (keeps custom source on disk)",
          (y2: YargsBuilder) =>
            noApplyOption(
              y2
                .option("app", { type: "string", demandOption: true })
                .option("kind", {
                  type: "string",
                  demandOption: true,
                  choices: ["vhost", "pool"] as const,
                }),
            ),
          bind(state, cmdTemplateReturn),
        )
        .command(
          "drift",
          "Report upstream template drift for custom apps",
          (y2: YargsBuilder) => y2.option("app", { type: "string" }),
          bind(state, cmdTemplateDrift),
        )
        .demandCommand(1, "Specify a template subcommand: select|return|drift")
        .recommendCommands());
}

// --- templates (F-24) --------------------------------------------------------

async function cmdTemplateSelect(
  argv: ArgsWith<"app" | "kind">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, kind } = argv;
  const noApply = wantsNoApply(argv);

  let source = argv.source;
  let copy = argv.noCopy !== true;
  if (!source) {
    const prepared = await prepareCustomTemplate(ctx.platform, await ctx.store.load(), slug, kind);
    source = prepared.path;
    copy = false;
    ctx.log.info(
      `${prepared.created ? "created" : "opening"} custom ${kind} template: ${source}`,
    );
    await openEditor(source);
  }

  const result = await ctx.store.withExclusive(async (state) => {
    const selected = await selectCustomTemplate(ctx.platform, state, {
      slug,
      kind,
      sourcePath: source,
      copy,
    });
    await ctx.store.save(selected.state);
    if (!noApply) {
      await ctx.render.apply(selected.state, {
        reloadPlan: selected.reloadPlan,
        skipValidate: false,
        alreadyLocked: true,
      });
    }
    return selected;
  });
  ctx.log.info(
    `activated custom ${kind} template for ${slug} -> ${result.recordedPath}`,
  );
  return 0;
}

async function cmdTemplateReturn(
  argv: ArgsWith<"app" | "kind">,
  ctx: CliContext,
): Promise<number> {
  const { app: slug, kind } = argv;
  const noApply = wantsNoApply(argv);
  const result = await ctx.store.withExclusive(async (state) => {
    const returned = returnToUpstreamTemplate(
      state,
      slug,
      kind,
      ctx.platform.clock.nowIso(),
    );
    await ctx.store.save(returned.state);
    if (!noApply) {
      await ctx.render.apply(returned.state, {
        reloadPlan: returned.reloadPlan,
        skipValidate: true,
        alreadyLocked: true,
      });
    }
    return returned;
  });
  if (result.preservedPath) {
    ctx.log.info(
      `returned ${slug} ${kind} to upstream; custom source preserved at ${result.preservedPath}`,
    );
  } else {
    ctx.log.info(`${slug} ${kind} already upstream`);
  }
  return 0;
}

async function cmdTemplateDrift(argv: CliArgs, ctx: CliContext): Promise<number> {
  const state = await ctx.store.load();
  const drifts = await detectTemplateDrift(
    ctx.platform,
    state,
    argv.app,
  );
  if (ctx.json) {
    ctx.log.out(JSON.stringify(drifts, null, 2));
  } else if (drifts.length === 0) {
    ctx.log.info("no custom templates");
  } else {
    const rows = drifts.map((d) => [
      d.slug,
      d.kind,
      d.drifted ? "DRIFT" : "ok",
      d.sourcePath,
    ]);
    ctx.log.out(printTable(["app", "kind", "status", "source"], rows));
    for (const w of formatDriftWarnings(drifts)) ctx.log.warn(w);
  }
  return drifts.some((d) => d.drifted) ? 1 : 0;
}
