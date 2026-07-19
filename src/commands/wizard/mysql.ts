import { basename } from "@std/path";
import {
  addMysqlVersion,
  buildMysqlShellPlan,
  listRecentBackupFiles,
  queryDatabaseSizes,
  resolveMysqlServices,
  runBackup,
  runRestore,
} from "../../services/mysql.ts";
import { requireMysqlRootPassword } from "../../services/stack_env.ts";
import { WizardUI } from "../../ui/tui.ts";
import type { CliContext } from "../context.ts";
import { ensureState, handleError, openMysqlShell, pcDim } from "./shared.ts";

export async function sectionMysql(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Manage MySQL");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("MySQL", [
      { label: "Open shell", value: "shell", hint: "root shell" },
      { label: "Add version", value: "add", hint: "new MySQL service" },
      { label: "Database sizes", value: "size" },
      { label: "Backup", value: "backup", hint: "database · app · all" },
      { label: "Restore", value: "restore", hint: "recent backup or file" },
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
      } else if (action === "size") {
        const rootPassword = await requireMysqlRootPassword(ctx.platform);
        const rows: string[][] = [];
        for (const service of resolveMysqlServices(state)) {
          const result = await queryDatabaseSizes(ctx.platform, service, rootPassword);
          for (const row of result.rows) {
            rows.push([
              service,
              row.database,
              row.tables,
              row.dataSize,
              row.indexSize,
              row.totalSize,
            ]);
          }
        }
        ui.table(
          ["service", "database", "tables", "data_size", "index_size", "total_size"],
          rows,
        );
      } else if (action === "backup") {
        await wizardBackup(ui, ctx);
      } else {
        await wizardRestore(ui, ctx);
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function wizardBackup(ui: WizardUI, ctx: CliContext): Promise<void> {
  const state = await ctx.store.load();
  const apps = Object.values(state.apps)
    .filter((app) => app.databases.length > 0)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (apps.length === 0) {
    ui.warn("No managed databases to back up");
    return;
  }

  const scope = await ui.menu<"database" | "app" | "all">("Backup scope", [
    { label: "Single database", value: "database" },
    { label: "Application", value: "app", hint: "all databases for one app" },
    { label: "All databases", value: "all", hint: "all managed applications" },
  ]);
  if (!scope) return;

  let slug: string | undefined;
  let database: string | undefined;
  if (scope !== "all") {
    slug = await ui.menu(
      "Application",
      apps.map((app) => ({
        label: app.slug,
        value: app.slug,
        hint: `${app.databases.length} database${app.databases.length === 1 ? "" : "s"}`,
      })),
    ) ?? undefined;
    if (!slug) return;

    if (scope === "database") {
      const app = state.apps[slug]!;
      database = await ui.menu(
        "Database",
        app.databases.map((db) => ({ label: db.name, value: db.name })),
      ) ?? undefined;
      if (!database) return;
    }
  }

  const compress = await ui.menu<"zstd" | "gzip" | "none">("Compression", [
    { label: "Zstandard", value: "zstd", hint: "recommended" },
    { label: "gzip", value: "gzip" },
    { label: "None", value: "none" },
  ]);
  if (!compress) return;

  ui.message(pcDim(
    `scriptable: bento backup ${scope === "all" ? "--all" : `--app ${slug}`}${
      database ? ` --database ${database}` : ""
    }${compress === "gzip" ? " --gzip" : compress === "none" ? " --none" : ""}`,
  ));
  if (!(await ui.confirm("Start backup?", { defaultYes: true }))) return;

  const artifacts = await runBackup(ctx.platform, state, { scope, slug, database, compress });
  ui.success(
    `Backup completed`,
    `${artifacts.length} database${artifacts.length === 1 ? "" : "s"}`,
  );
  ui.table(
    ["database", "size", "file"],
    artifacts.map((artifact) => [
      artifact.database,
      formatBytes(artifact.bytes),
      artifact.path,
    ]),
  );
}

async function wizardRestore(ui: WizardUI, ctx: CliContext): Promise<void> {
  const state = await ctx.store.load();
  const apps = Object.values(state.apps).sort((a, b) => a.slug.localeCompare(b.slug));
  if (apps.length === 0) {
    ui.warn("No managed applications available for restore");
    return;
  }

  const recent = await listRecentBackupFiles(ctx.platform);
  const customPath = "__custom_path__";
  const source = await ui.menu("Backup file", [
    ...recent.map((file) => ({
      label: basename(file.path),
      value: file.path,
      hint: `${formatBytes(file.bytes)} · ${formatDate(file.createdAt)}`,
    })),
    { label: "Enter another path…", value: customPath },
  ]);
  if (!source) return;
  const file = source === customPath
    ? await ui.prompt("Backup file path", { required: true })
    : source;
  if (!file) return;

  const slug = await ui.menu(
    "Restore into application",
    apps.map((app) => ({
      label: app.slug,
      value: app.slug,
      hint: app.mysqlService,
    })),
  );
  if (!slug) return;
  const app = state.apps[slug]!;

  const newTarget = "__new_database__";
  const selectedTarget = await ui.menu("Target database", [
    ...app.databases.map((db) => ({
      label: db.name,
      value: db.name,
      hint: "replace existing database",
    })),
    { label: "New database…", value: newTarget },
  ]);
  if (!selectedTarget) return;
  const target = selectedTarget === newTarget
    ? await ui.prompt("New database name", { default: `${slug}_restored`, required: true })
    : selectedTarget;
  if (!target) return;

  let replaceOriginal: string | undefined;
  if (app.databases.some((db) => db.name === target)) {
    ui.warn(
      `This will drop and recreate ${target}`,
      "Restore is not object-level atomic; a failed import can leave a partial database.",
    );
    const confirmation = await ui.prompt(`Type ${target} to confirm replacement`, {
      required: true,
    });
    if (confirmation !== target) {
      ui.info("Restore cancelled: confirmation did not match.");
      return;
    }
    replaceOriginal = target;
  } else {
    ui.warn(
      `Restore into new database ${target}`,
      "Restore is not object-level atomic; a failed import can leave a partial database.",
    );
    if (!(await ui.confirm("Start restore?"))) return;
  }

  ui.message(pcDim(
    `scriptable: bento restore --file ${file} --app ${slug} --target ${target}${
      replaceOriginal ? ` --replace ${replaceOriginal}` : ""
    }`,
  ));
  await runRestore(ctx.platform, state, {
    file,
    slug,
    targetDatabase: target,
    replaceOriginal,
  });
  ui.success("Restore completed", target);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().replace("T", " ").slice(0, 16) : "unknown date";
}
