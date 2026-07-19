import { capacityWarnings } from "../../services/app.ts";
import { listMysqlVersions } from "../../services/mysql.ts";
import { listPhpVersions } from "../../services/php.ts";
import { buildStatus, formatStatus } from "../../services/status.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState } from "./shared.ts";

export async function sectionStatus(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Status & diagnostics");
  if (!(await ensureState(ui, ctx))) return;

  const action = await ui.menu("Status", [
    { label: "Full stack status", value: "full" },
    { label: "List applications", value: "apps" },
    { label: "List PHP versions", value: "php" },
    { label: "List MySQL versions", value: "mysql" },
    { label: "List reverse proxies", value: "proxy" },
    { label: "Capacity warnings", value: "capacity" },
  ]);
  if (!action) return;

  const state = await ctx.store.load();
  if (action === "full") {
    const report = await buildStatus(ctx.platform, state);
    ui.blank();
    ui.message(formatStatus(report));
  } else if (action === "apps") {
    const rows = Object.values(state.apps)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((a) => [
        a.slug,
        String(a.uid),
        a.mainDomain,
        a.phpVersion,
        a.fpmProfile,
        a.tls.kind,
        a.mysqlService,
      ]);
    ui.table(["slug", "uid", "domain", "php", "fpm", "tls", "mysql"], rows);
  } else if (action === "php") {
    const rows = listPhpVersions(state).map((v) => [
      v.version,
      v.service,
      `${v.service}-runner`,
      v.image,
      String(v.processCap),
    ]);
    ui.table(["version", "fpm", "runner", "image", "cap"], rows);
  } else if (action === "mysql") {
    const rows = listMysqlVersions(state).map((v) => [
      v.version,
      v.service,
      v.volume,
      v.image,
    ]);
    ui.table(["version", "service", "volume", "image"], rows);
  } else if (action === "proxy") {
    const rows = Object.values(state.proxies).map((p) => [
      p.name,
      p.mainDomain,
      p.upstreams.join(", "),
      p.tls.kind,
    ]);
    ui.table(["name", "domain", "upstream", "tls"], rows);
  } else if (action === "capacity") {
    const warnings = capacityWarnings(state);
    if (warnings.length === 0) ui.success("No capacity warnings");
    else {
      ui.warn("Capacity warnings");
      for (const w of warnings) ui.message(`  • ${w}`);
    }
  }
  await ui.pause();
}
