import {
  addMysqlVersion,
  buildMysqlShellPlan,
  queryDatabaseSizes,
  resolveMysqlServices,
} from "../../services/mysql.ts";
import { requireMysqlRootPassword } from "../../services/stack_env.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError, openMysqlShell } from "./shared.ts";

export async function sectionMysql(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Manage MySQL");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("MySQL", [
      { label: "Open shell", value: "shell", hint: "root shell" },
      { label: "Add version", value: "add", hint: "new MySQL service" },
      { label: "Database sizes", value: "size" },
    ]);
    if (!action) return;

    try {
      const state = await ctx.store.load();
      if (action === "add") {
        const version = await ui.prompt("MySQL version (e.g. 8.4)", { required: true });
        if (!version) continue;
        await ctx.store.withExclusive(async (current) => {
          const next = addMysqlVersion(current, version);
          await ctx.store.save(next);
          await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
          return next;
        });
        ui.success(`Added MySQL ${version}`);
      } else if (action === "shell") {
        const services = resolveMysqlServices(state);
        if (services.length === 0) {
          ui.error("No MySQL service managed");
          await ui.pause();
          continue;
        }
        const service = services.length === 1 ? services[0]! : await ui.menu(
          "MySQL service",
          services.map((value) => ({ label: value, value })),
        );
        if (!service) continue;
        await openMysqlShell(
          ui,
          ctx,
          buildMysqlShellPlan(ctx.platform, { kind: "root", service }),
          "bento mysql shell --root",
        );
      } else {
        const rootPassword = await requireMysqlRootPassword(ctx.platform);
        const rows: string[][] = [];
        for (const service of resolveMysqlServices(state)) {
          const result = await queryDatabaseSizes(ctx.platform, service, rootPassword);
          for (const row of result.rows) {
            rows.push([service, row.database, row.sizeMb, row.tables]);
          }
        }
        ui.table(["service", "database", "size_mb", "tables"], rows);
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}
