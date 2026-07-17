import { addCronJob, listCronJobs, removeCronJob } from "../../services/cron.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { handleError } from "./shared.ts";

export async function sectionCron(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Cron jobs: ${slug}`);

  while (true) {
    const action = await ui.menu("Cron", [
      { label: "List jobs", value: "list" },
      { label: "Add job", value: "add" },
      { label: "Remove job", value: "remove" },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = listCronJobs(state, slug).map((j) => [
        j.name,
        j.schedule,
        j.command.join(" "),
        j.enabled ? "yes" : "no",
      ]);
      ui.table(["name", "schedule", "command", "enabled"], rows);
      await ui.pause();
    } else if (action === "add") {
      const name = await ui.prompt("Job name", { required: true });
      if (!name) continue;
      const schedule = await ui.prompt("Cron schedule", {
        required: true,
        default: "*/5 * * * *",
      });
      if (!schedule) continue;
      const cmdRaw = await ui.prompt("Shell command", {
        required: true,
        default: "php artisan schedule:run",
      });
      if (!cmdRaw) continue;
      const timezone = await ui.prompt("Timezone (blank = default)", { default: "" });
      if (timezone === null) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const r = addCronJob(state, {
            app: slug,
            name,
            schedule,
            command: [cmdRaw],
            commandMode: "shell",
            timezone: timezone || undefined,
          }, ctx.platform);
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Added cron ${name}`, `app=${slug} schedule=${schedule}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "remove") {
      const state = await ctx.store.load();
      const jobs = listCronJobs(state, slug);
      if (jobs.length === 0) {
        ui.info("No cron jobs");
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        "Remove cron job",
        jobs.map((j) => ({
          label: j.name,
          value: j.name,
          hint: j.schedule,
        })),
      );
      if (!picked) continue;
      if (!(await ui.confirm(`Remove cron ${picked} for ${slug}?`))) continue;
      try {
        await ctx.store.withExclusive(async (s) => {
          const r = removeCronJob(s, slug, picked, ctx.platform.clock.nowIso());
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Removed cron ${picked}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}
