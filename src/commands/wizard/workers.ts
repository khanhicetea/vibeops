import {
  addWorker,
  buildWorkerControlPlan,
  buildWorkerSignalPlan,
  controlWorker,
  inspectWorker,
  listWorkers,
  removeWorker,
  type WorkerControlAction,
} from "../../services/worker.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { handleError } from "./shared.ts";

export async function sectionWorker(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Workers: ${slug}`);

  while (true) {
    const action = await ui.menu("Workers", [
      { label: "List workers", value: "list" },
      { label: "Add worker", value: "add" },
      { label: "Remove worker", value: "remove" },
      { label: "Start worker", value: "start" },
      { label: "Stop worker", value: "stop" },
      { label: "Restart worker", value: "restart" },
      { label: "Signal worker", value: "signal" },
      { label: "Inspect worker", value: "inspect" },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = listWorkers(state, slug).map((w) => [
        w.name,
        w.command.join(" "),
        w.enabled ? "yes" : "no",
      ]);
      ui.table(["name", "command", "enabled"], rows);
      await ui.pause();
    } else if (action === "add") {
      const name = await ui.prompt("Worker name", { required: true });
      if (!name) continue;
      const cmdRaw = await ui.prompt("Command (space-separated argv)", {
        required: true,
        default: "php artisan queue:work",
      });
      if (!cmdRaw) continue;
      const command = cmdRaw.split(/\s+/).filter(Boolean);
      try {
        await ctx.store.withExclusive(async (state) => {
          const r = addWorker(state, { app: slug, name, command }, ctx.platform);
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Added worker ${name}`, `app=${slug}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "remove") {
      const state = await ctx.store.load();
      const workers = listWorkers(state, slug);
      if (workers.length === 0) {
        ui.info(`No workers for ${slug}`);
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        "Remove worker",
        workers.map((w) => ({
          label: w.name,
          value: w.name,
          hint: w.command.join(" "),
        })),
      );
      if (!picked) continue;
      if (!(await ui.confirm(`Remove worker ${picked} for ${slug}?`))) continue;
      try {
        await ctx.store.withExclusive(async (s) => {
          const r = removeWorker(s, slug, picked, ctx.platform.clock.nowIso());
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Removed worker ${picked}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (
      action === "start" || action === "stop" || action === "restart" ||
      action === "signal" || action === "inspect"
    ) {
      const state = await ctx.store.load();
      const workers = listWorkers(state, slug);
      if (workers.length === 0) {
        ui.info(`No workers for ${slug}`);
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        `${action} worker`,
        workers.map((w) => ({
          label: w.name,
          value: w.name,
          hint: w.command.join(" "),
        })),
      );
      if (!picked) continue;
      try {
        if (action === "inspect") {
          const result = await inspectWorker(ctx.platform, state, slug, picked);
          ui.message(
            [
              `program: ${result.plan.program}`,
              `runner: ${result.plan.runnerService}`,
              `status: ${result.stdout.trim() || result.stderr.trim() || "(no output)"}`,
            ].join("\n"),
          );
        } else {
          const signal = action === "signal"
            ? await ui.prompt("Signal", { required: true, default: "HUP" })
            : undefined;
          if (action === "signal" && !signal) continue;
          const plan = action === "signal"
            ? buildWorkerSignalPlan(state, slug, picked, signal!)
            : buildWorkerControlPlan(
              state,
              slug,
              picked,
              action as WorkerControlAction,
            );
          const result = await controlWorker(ctx.platform, plan);
          if (result.code === 0) {
            ui.success(`${action} ${plan.program}`);
            if (result.stdout.trim()) ui.message(result.stdout.trim());
          } else {
            ui.error(result.stderr.trim() || result.stdout.trim() || `${action} failed`);
          }
        }
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}
