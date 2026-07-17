/**
 * Interactive wizard (TUI) for Bento operator workflows.
 * Guided numbered menus over the same services as scripted CLI commands.
 */

import { relative } from "@std/path";
import { isBentoError } from "../domain/errors.ts";
import type { TlsMode } from "../domain/state.ts";
import { FPM_PROFILES } from "../domain/types.ts";
import { describeReloadPlan } from "../domain/reload.ts";
import {
  applyAppDataPlane,
  capacityWarnings,
  materializeAppHome,
  provisionApp,
} from "../services/app.ts";
import {
  addPhpVersion,
  buildCliExec,
  cliRunComposeCommand,
  listPhpVersions,
  removePhpVersion,
} from "../services/php.ts";
import {
  addMysqlVersion,
  buildMysqlShellPlan,
  createAppDatabaseLive,
  listMysqlVersions,
  listRecentBackupFiles,
  queryDatabaseSizes,
  queryProcesslist,
  resolveMysqlServices,
  runBackup,
  runRestore,
} from "../services/mysql.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "../services/stack_env.ts";
import { createProxy } from "../services/proxy.ts";
import {
  deployWebhookInstructions,
  disableDeploy,
  drainDeploy,
  enableDeploy,
  loadQueue,
  rotateDeploySecret,
} from "../services/deploy.ts";
import { addCronJob, listCronJobs, removeCronJob } from "../services/cron.ts";
import {
  addWorker,
  buildWorkerControlPlan,
  controlWorker,
  inspectWorker,
  listWorkers,
  removeWorker,
  type WorkerControlAction,
} from "../services/worker.ts";
import { generateAccessReport, rotateAccessLog, setAppAccessLog } from "../services/access_log.ts";
import {
  detectTemplateDrift,
  formatDriftWarnings,
  returnToUpstreamTemplate,
  selectCustomTemplate,
  type TemplateKind,
} from "../services/customization.ts";
import { runStackMaintenance } from "../services/maintenance.ts";
import { buildStatus, formatStatus } from "../services/status.ts";
import { checkPermissions, formatPermReport, repairPermissions } from "../services/permissions.ts";
import { assertSafeComposeArgs, composeArgs } from "../services/compose.ts";
import { redact } from "../ui/output.ts";
import { type MenuChoice, type TableMenuChoice, WizardUI } from "../ui/tui.ts";
import { BENTO_VERSION } from "../version.ts";
import type { CliContext } from "./context.ts";

type WizardAction = () => Promise<void>;

export async function runWizard(ctx: CliContext): Promise<number> {
  const ui = new WizardUI();
  if (!ui.isInteractive()) {
    ctx.log.error(
      "tui requires an interactive terminal (stdin/stdout TTY). Use scripted commands instead.",
    );
    return 2;
  }

  ui.clear();
  ui.header("Bento Wizard", `v${BENTO_VERSION}  ·  stack ${ctx.stackRoot}`);
  ui.message("Guided operator workflows. All actions map to scriptable CLI commands.");
  ui.note([
    "↑/↓ (or j/k) move highlight · Enter confirms · number/letter key selects instantly.",
    "0 / q / Esc goes back. Secrets are shown only when freshly generated/rotated.",
  ]);
  ui.blank();

  try {
    while (true) {
      const choice = await ui.menu<string>("Main menu", [
        { label: "Status & diagnostics", value: "status", hint: "stack / apps / capacity" },
        { label: "Bootstrap", value: "bootstrap", hint: "init · render · apply" },
        { label: "Applications", value: "apps", hint: "create · list · show · shell" },
        { label: "PHP versions", value: "php", hint: "add · remove · list" },
        { label: "MySQL", value: "mysql", hint: "versions · databases · shell · size" },
        { label: "Reverse proxies", value: "proxy", hint: "create · list" },
        { label: "Deploy webhooks", value: "deploy", hint: "enable · rotate · drain" },
        { label: "Cron jobs", value: "cron", hint: "add · remove · list" },
        { label: "Workers", value: "worker", hint: "add · control · list" },
        { label: "Access logs", value: "logs", hint: "enable · rotate · report" },
        { label: "Templates", value: "template", hint: "custom vhost/pool · drift" },
        { label: "Maintenance", value: "maintenance", hint: "retention · host cron" },
        { label: "TLS", value: "tls", hint: "boot · acme · external" },
        { label: "Permissions", value: "permissions", hint: "check · repair" },
        { label: "Backup / restore", value: "backup", hint: "MySQL dumps" },
        { label: "Compose helpers", value: "compose", hint: "safe docker compose" },
      ], { cancelLabel: "Quit", allowCancel: true });

      if (choice === null) {
        ui.blank();
        ui.message(pcDim("Goodbye."));
        return 0;
      }

      ui.clear();
      try {
        await dispatch(ui, ctx, choice);
      } catch (err) {
        handleError(ui, err);
        await ui.pause();
      }
      ui.clear();
      ui.header("Bento Wizard", `stack ${ctx.stackRoot}`);
    }
  } catch (err) {
    if (err instanceof WizardExit) return err.code;
    handleError(ui, err);
    return 1;
  }
}

class WizardExit extends Error {
  constructor(readonly code: number) {
    super(`wizard-exit ${code}`);
    this.name = "WizardExit";
  }
}

function pcDim(s: string): string {
  // local helper to avoid importing picocolors into every message site for dim-only
  return `\x1b[2m${s}\x1b[22m`;
}

function formatHumanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatBackupDate(date: Date | null): string {
  return date ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : "unknown";
}

function handleError(ui: WizardUI, err: unknown): void {
  if (isBentoError(err)) {
    ui.error(redact(err.message), err.recovery ? `recovery: ${err.recovery}` : undefined);
    return;
  }
  ui.error(redact(err instanceof Error ? err.message : String(err)));
}

async function dispatch(ui: WizardUI, ctx: CliContext, section: string): Promise<void> {
  const map: Record<string, WizardAction> = {
    status: () => sectionStatus(ui, ctx),
    bootstrap: () => sectionBootstrap(ui, ctx),
    apps: () => sectionApps(ui, ctx),
    php: () => sectionPhp(ui, ctx),
    mysql: () => sectionMysql(ui, ctx),
    proxy: () => sectionProxy(ui, ctx),
    deploy: () => sectionDeploy(ui, ctx),
    cron: () => sectionCron(ui, ctx),
    worker: () => sectionWorker(ui, ctx),
    logs: () => sectionLogs(ui, ctx),
    template: () => sectionTemplate(ui, ctx),
    maintenance: () => sectionMaintenance(ui, ctx),
    tls: () => sectionTls(ui, ctx),
    permissions: () => sectionPermissions(ui, ctx),
    backup: () => sectionBackup(ui, ctx),
    compose: () => sectionCompose(ui, ctx),
  };
  const fn = map[section];
  if (fn) await fn();
}

// --- shared pickers ----------------------------------------------------------

async function pickApp(
  ui: WizardUI,
  ctx: CliContext,
  opts?: { allowNone?: boolean; title?: string },
): Promise<string | null> {
  const state = await ctx.store.load();
  const apps = Object.values(state.apps).sort((a, b) => a.slug.localeCompare(b.slug));
  if (apps.length === 0) {
    ui.warn("No applications yet", "Create one from Applications → Create app");
    await ui.pause();
    return null;
  }
  const choices: MenuChoice<string>[] = apps.map((a) => ({
    label: a.slug,
    value: a.slug,
    hint: `${a.mainDomain} · php ${a.phpVersion} · ${a.tls.kind}`,
  }));
  return await ui.menu(opts?.title ?? "Select application", choices, {
    allowCancel: true,
    cancelLabel: opts?.allowNone ? "None / cancel" : "Cancel",
  });
}

async function ensureState(ui: WizardUI, ctx: CliContext): Promise<boolean> {
  try {
    await ctx.store.load();
    return true;
  } catch {
    ui.warn(
      "Stack not initialized",
      `Run Bootstrap → Initialize, or: bento --stack ${ctx.stackRoot} init`,
    );
    await ui.pause();
    return false;
  }
}

// --- sections ----------------------------------------------------------------

async function sectionStatus(ui: WizardUI, ctx: CliContext): Promise<void> {
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
      p.upstream,
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

async function sectionBootstrap(ui: WizardUI, ctx: CliContext): Promise<void> {
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

async function sectionApps(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Applications");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Applications", [
      { label: "List apps", value: "list" },
      { label: "Show app details", value: "show", hint: "secrets redacted" },
      { label: "Create / update app", value: "create" },
      {
        label: "Open CLI shell",
        value: "shell",
        hint: "attach ephemeral PHP CLI as app identity",
      },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = Object.values(state.apps)
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((a) => [
          a.slug,
          String(a.uid),
          a.mainDomain,
          a.phpVersion,
          a.fpmProfile,
          a.tls.kind,
          a.deploy.enabled ? "on" : "off",
        ]);
      ui.blank();
      ui.table(["slug", "uid", "domain", "php", "fpm", "tls", "deploy"], rows);
      await ui.pause();
    } else if (action === "show") {
      const slug = await pickApp(ui, ctx);
      if (!slug) continue;
      const state = await ctx.store.load();
      const app = state.apps[slug]!;
      const safe = {
        ...app,
        mysqlPassword: "***",
        redis: {
          ...app.redis,
          password: app.redis.password ? "***" : undefined,
          aclPassword: app.redis.aclPassword ? "***" : undefined,
        },
        deploy: {
          ...app.deploy,
          hmacSecret: app.deploy.hmacSecret ? "***" : undefined,
        },
      };
      ui.blank();
      ui.message(JSON.stringify(safe, null, 2));
      await ui.pause();
    } else if (action === "create") {
      await wizardAppCreate(ui, ctx);
    } else if (action === "shell") {
      await wizardAppShell(ui, ctx);
    }
  }
}

/** Attach interactive ephemeral PHP CLI shell as the selected app identity. */
async function wizardAppShell(ui: WizardUI, ctx: CliContext): Promise<void> {
  const slug = await pickApp(ui, ctx, { title: "App for CLI shell" });
  if (!slug) return;

  const workdirRaw = await ui.prompt("Working directory (blank = app home)", {
    default: "",
  });
  if (workdirRaw === null) return;

  try {
    const state = await ctx.store.load();
    const plan = buildCliExec(
      ctx.platform,
      state,
      slug,
      [], // default interactive bash
      { workdir: workdirRaw.trim() || undefined },
    );
    const composeCmd = cliRunComposeCommand(plan, { tty: true });
    const compose = await composeArgs(ctx.platform, state, composeCmd);

    ui.blank();
    ui.info(
      `Attaching ${plan.service} as uid ${plan.user} · php ${plan.phpVersion} · ${plan.workdir}`,
    );
    ui.message(
      `scriptable: bento app shell ${slug}${
        workdirRaw.trim() ? ` --workdir ${workdirRaw.trim()}` : ""
      }`,
    );
    ui.message(pcDim(`$ ${compose.join(" ")}`));
    ui.blank();
    ui.message(pcDim("Exit the shell to return to the wizard."));
    ui.blank();

    const [cmd, ...args] = compose;
    const child = new Deno.Command(cmd!, {
      args,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.output();
    ui.blank();
    if (status.code === 0) {
      ui.success(`Shell closed`, `app ${slug}`);
    } else {
      ui.warn(`Shell exited ${status.code}`, `app ${slug}`);
    }
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}

async function wizardAppCreate(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.blank();
  ui.message(pcDim("Create or update an application (same identity on update)."));
  const slug = await ui.prompt("App slug", { required: true });
  if (slug === null) return;
  const domain = await ui.prompt("Primary domain", { required: true });
  if (domain === null) return;
  const aliasRaw = await ui.prompt("Domain aliases (comma-separated)", { default: "" });
  if (aliasRaw === null) return;
  const aliases = aliasRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const state = await ctx.store.load();
  const phpChoices: MenuChoice<string>[] = state.phpVersions.map((v) => ({
    label: v.version,
    value: v.version,
    hint: v.version === state.defaults.phpVersion ? "default" : v.image,
  }));
  phpChoices.push({ label: `Use default (${state.defaults.phpVersion})`, value: "" });
  const php = await ui.menu("PHP version", phpChoices);
  if (php === null) return;

  const fpmChoices: MenuChoice<string>[] = Object.keys(FPM_PROFILES).map((p) => ({
    label: p,
    value: p,
    hint: p === state.defaults.fpmProfile ? "default" : undefined,
  }));
  fpmChoices.push({ label: `Use default (${state.defaults.fpmProfile})`, value: "" });
  const fpm = await ui.menu("FPM profile", fpmChoices);
  if (fpm === null) return;

  const docroot = await ui.prompt("Document root (relative to app home)", {
    default: "public",
  });
  if (docroot === null) return;

  const entry = await ui.menu<"front-controller" | "legacy" | "">("Entrypoint mode", [
    { label: "Front controller (recommended)", value: "front-controller" },
    { label: "Legacy (direct PHP file execution)", value: "legacy" },
    { label: "Keep existing / default", value: "" },
  ]);
  if (entry === null) return;

  const createDb = await ui.confirm("Create a namespaced database for this app?");
  const databaseName = createDb
    ? await ui.prompt("Database name (blank = auto)", { default: "" })
    : "";
  if (createDb && databaseName === null) return;

  const accessLog = await ui.confirm("Enable per-app access logs?", { defaultYes: false });
  const noApply = !(await ui.confirm("Render & apply after save?", { defaultYes: true }));

  ui.blank();
  ui.table(
    ["field", "value"],
    [
      ["slug", slug],
      ["domain", domain],
      ["aliases", aliases.join(", ") || "-"],
      ["php", php || `(default ${state.defaults.phpVersion})`],
      ["fpm", fpm || `(default ${state.defaults.fpmProfile})`],
      ["docroot", docroot || "public"],
      ["entry", entry || "default"],
      ["database", createDb ? (databaseName || "auto") : "no"],
      ["access-log", accessLog ? "yes" : "no"],
      ["apply", noApply ? "skip" : "yes"],
    ],
  );

  if (!(await ui.confirm("Proceed?", { defaultYes: true }))) {
    ui.info("Cancelled.");
    await ui.pause();
    return;
  }

  try {
    const result = await ctx.store.withExclusive(async (s) => {
      const provisioned = provisionApp(ctx.platform, s, {
        slug,
        domain,
        aliases,
        documentRoot: docroot || undefined,
        entrypointMode: entry || undefined,
        phpVersion: php || undefined,
        fpmProfile: fpm || undefined,
        createDatabase: createDb,
        databaseName: databaseName || undefined,
        accessLog,
      });
      const plane = await applyAppDataPlane(ctx.platform, provisioned.app, {
        explicitDatabase: createDb,
      });
      const redisShared = await loadRedisPassword(ctx.platform);
      await materializeAppHome(ctx.platform, provisioned.app, {
        recursivePerms: true,
        redisSharedPassword: redisShared,
      });
      await ctx.store.save(provisioned.state);
      if (!noApply) {
        await ctx.render.apply(provisioned.state, {
          reloadPlan: provisioned.reloadPlan,
          skipValidate: false,
          alreadyLocked: true,
        });
      }
      return { provisioned, plane };
    });
    ui.success(
      `${result.provisioned.created ? "Created" : "Updated"} app ${result.provisioned.app.slug}`,
      `uid=${result.provisioned.app.uid} domain=${result.provisioned.app.mainDomain}`,
    );
    for (const note of result.plane.deferredNotes) ui.warn(note);
    for (const w of capacityWarnings(result.provisioned.state)) ui.warn(w);
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}

async function sectionPhp(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("PHP versions");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("PHP", [
      { label: "List versions", value: "list" },
      { label: "Add version", value: "add", hint: "creates fpm+runner+cli" },
      { label: "Remove unused version", value: "remove" },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = listPhpVersions(state).map((v) => [
        v.version,
        v.service,
        v.image,
        String(v.processCap),
      ]);
      ui.table(["version", "service", "image", "cap"], rows);
      await ui.pause();
    } else if (action === "add") {
      const version = await ui.prompt("PHP version (e.g. 8.3)", { required: true });
      if (!version) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const next = addPhpVersion(state, version);
          await ctx.store.save(next);
          await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
          return next;
        });
        ui.success(`Added PHP ${version}`, "fpm + runner + cli roles");
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "remove") {
      const state = await ctx.store.load();
      const choices = listPhpVersions(state).map((v) => ({
        label: v.version,
        value: v.version,
        hint: v.version === state.defaults.phpVersion ? "default (blocked)" : undefined,
        disabled: v.version === state.defaults.phpVersion,
      }));
      const version = await ui.menu("Remove PHP version", choices);
      if (!version) continue;
      if (!(await ui.confirm(`Remove PHP ${version}? Only allowed when unused.`))) continue;
      try {
        await ctx.store.withExclusive(async (s) => {
          const next = removePhpVersion(s, version);
          await ctx.store.save(next);
          await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
          return next;
        });
        ui.success(`Removed PHP ${version}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}

async function sectionMysql(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("MySQL");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("MySQL", [
      { label: "List versions", value: "list" },
      { label: "Add version service", value: "add" },
      {
        label: "Remove version",
        value: "remove",
        hint: "blocked by design",
        disabled: true,
      },
      { label: "Record database for app", value: "db" },
      { label: "Open shell (root)", value: "shell-root", hint: "scriptable: mysql shell --root" },
      { label: "Open shell (app)", value: "shell-app", hint: "scriptable: mysql shell --app" },
      { label: "Database sizes", value: "size" },
      { label: "Process list", value: "processlist" },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = listMysqlVersions(state).map((v) => [
        v.version,
        v.service,
        v.volume,
        v.image,
      ]);
      ui.table(["version", "service", "volume", "image"], rows);
      await ui.pause();
    } else if (action === "add") {
      const version = await ui.prompt("MySQL version (e.g. 8.4)", { required: true });
      if (!version) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const next = addMysqlVersion(state, version);
          await ctx.store.save(next);
          await ctx.render.apply(next, { skipValidate: true, alreadyLocked: true });
          return next;
        });
        ui.success(`Added MySQL ${version}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "db") {
      const slug = await pickApp(ui, ctx, { title: "App that owns the database" });
      if (!slug) continue;
      const dbName = await ui.prompt("Database name", { required: true });
      if (!dbName) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const rootPassword = await requireMysqlRootPassword(ctx.platform);
          const next = await createAppDatabaseLive(
            ctx.platform,
            state,
            slug,
            dbName,
            rootPassword,
          );
          const app = next.apps[slug]!;
          const redisShared = await loadRedisPassword(ctx.platform);
          await materializeAppHome(ctx.platform, app, {
            recursivePerms: false,
            redisSharedPassword: redisShared,
          });
          await ctx.store.save(next);
          return next;
        });
        ui.success(`Created database ${dbName}`, `app=${slug}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "shell-root" || action === "shell-app") {
      try {
        const state = await ctx.store.load();
        let plan;
        if (action === "shell-root") {
          const services = resolveMysqlServices(state);
          const service = services[0];
          if (!service) {
            ui.error("No MySQL service managed");
            await ui.pause();
            continue;
          }
          plan = buildMysqlShellPlan(ctx.platform, {
            kind: "root",
            service,
          });
        } else {
          const slug = await pickApp(ui, ctx);
          if (!slug) continue;
          const app = state.apps[slug];
          if (!app) continue;
          plan = buildMysqlShellPlan(ctx.platform, { kind: "app", app });
        }
        ui.blank();
        ui.info(
          `Attaching MySQL shell to ${plan.service} as ${plan.user}${
            plan.database ? ` · database=${plan.database}` : ""
          }`,
        );
        ui.message(
          pcDim(
            `scriptable: ${
              action === "shell-root"
                ? "bento mysql shell --root"
                : `bento mysql shell --app ${plan.user.replace(/^app_/, "") || "<slug>"}`
            }`,
          ),
        );
        ui.message(pcDim("Exit the MySQL client to return to the wizard."));
        ui.blank();

        // App sessions stage credentials through stdin. Root sessions use the
        // generated read-only option file mounted in the MySQL container.
        if (plan.stage) {
          const staged = await ctx.platform.process.run(plan.stage.command, {
            cwd: ctx.stackRoot,
            stdin: plan.stage.stdin,
            timeoutMs: 15_000,
          });
          if (staged.code !== 0) {
            ui.error(
              "Failed to stage MySQL credentials",
              (staged.stderr || staged.stdout || "unknown error").trim(),
            );
            await ui.pause();
            continue;
          }
        }
        let exitCode = 1;
        try {
          const [cmd, ...args] = plan.open.command;
          const child = new Deno.Command(cmd!, {
            args,
            cwd: ctx.stackRoot,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          exitCode = (await child.output()).code;
        } finally {
          if (plan.cleanup) {
            await ctx.platform.process.run(plan.cleanup.command, {
              cwd: ctx.stackRoot,
              timeoutMs: 10_000,
            }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
          }
        }
        ui.blank();
        if (exitCode === 0) {
          ui.success("MySQL shell closed", plan.service);
        } else {
          ui.warn(`MySQL shell exited ${exitCode}`, plan.service);
        }
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "size") {
      try {
        const state = await ctx.store.load();
        const rootPassword = await requireMysqlRootPassword(ctx.platform);
        const services = resolveMysqlServices(state);
        const rows: string[][] = [];
        for (const service of services) {
          const { rows: sized } = await queryDatabaseSizes(
            ctx.platform,
            service,
            rootPassword,
          );
          for (const r of sized) {
            rows.push([service, r.database, r.sizeMb, r.tables]);
          }
        }
        ui.table(["service", "database", "size_mb", "tables"], rows);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "processlist") {
      try {
        const state = await ctx.store.load();
        const rootPassword = await requireMysqlRootPassword(ctx.platform);
        const services = resolveMysqlServices(state);
        for (const service of services) {
          const { stdout } = await queryProcesslist(
            ctx.platform,
            service,
            rootPassword,
          );
          ui.message(`-- ${service} --\n${stdout.trimEnd() || "(empty)"}`);
        }
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}

async function sectionProxy(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Reverse proxies");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Proxies", [
      { label: "List proxies", value: "list" },
      { label: "Create proxy", value: "create" },
    ]);
    if (!action) return;

    if (action === "list") {
      const state = await ctx.store.load();
      const rows = Object.values(state.proxies).map((p) => [
        p.name,
        p.mainDomain,
        p.upstream,
        p.tls.kind,
      ]);
      ui.table(["name", "domain", "upstream", "tls"], rows);
      await ui.pause();
    } else if (action === "create") {
      const name = await ui.prompt("Proxy name", { required: true });
      if (!name) continue;
      const domain = await ui.prompt("Primary domain", { required: true });
      if (!domain) continue;
      const upstream = await ui.prompt("Upstream URL", {
        required: true,
        default: "http://127.0.0.1:3000",
      });
      if (!upstream) continue;
      const aliasRaw = await ui.prompt("Aliases (comma-separated)", { default: "" });
      if (aliasRaw === null) continue;
      try {
        await ctx.store.withExclusive(async (state) => {
          const result = createProxy(state, {
            name,
            domain,
            upstream,
            aliases: aliasRaw.split(",").map((s) => s.trim()).filter(Boolean),
          }, ctx.platform.clock.nowIso());
          await ctx.store.save(result.state);
          await ctx.render.apply(result.state, {
            reloadPlan: result.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return result;
        });
        ui.success(`Created proxy ${name}`, `${domain} → ${upstream}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}

async function sectionDeploy(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Deploy webhooks");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Deploy", [
      { label: "Enable webhook deploy", value: "enable" },
      { label: "Disable webhook deploy", value: "disable" },
      { label: "Rotate HMAC secret", value: "rotate", hint: "printed once" },
      { label: "Queue status / history", value: "status" },
      { label: "Drain one queued job", value: "drain" },
      { label: "Show webhook instructions", value: "instructions" },
    ]);
    if (!action) return;

    const slug = await pickApp(ui, ctx);
    if (!slug) continue;

    try {
      if (action === "enable") {
        const fifo = await ui.confirm("Use FIFO queue policy? (default: latest)", {
          defaultYes: false,
        });
        const result = await ctx.store.withExclusive(async (state) => {
          const enabled = enableDeploy(state, {
            slug,
            queuePolicy: fifo ? "fifo" : "latest",
          }, ctx.platform);
          await materializeAppHome(ctx.platform, enabled.state.apps[slug]!, false);
          await ctx.store.save(enabled.state);
          await ctx.render.apply(enabled.state, {
            reloadPlan: enabled.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return enabled;
        });
        ui.success(`Deploy enabled for ${slug}`);
        ui.blank();
        ui.message(deployWebhookInstructions(result.state.apps[slug]!, result.secret));
      } else if (action === "disable") {
        if (!(await ui.confirm(`Disable deploy for ${slug}?`))) continue;
        await ctx.store.withExclusive(async (state) => {
          const r = disableDeploy(state, slug, ctx.platform.clock.nowIso());
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Deploy disabled for ${slug}`);
      } else if (action === "rotate") {
        ui.warn("New secret will be printed once");
        if (!(await ui.confirm(`Rotate deploy secret for ${slug}?`))) continue;
        const result = await ctx.store.withExclusive(async (state) => {
          const r = rotateDeploySecret(state, slug, ctx.platform);
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success("Secret rotated (copy now)");
        ui.blank();
        ui.message(result.secret);
        ui.blank();
      } else if (action === "status") {
        const state = await ctx.store.load();
        const app = state.apps[slug];
        if (!app) {
          ui.error(`app not found: ${slug}`);
        } else {
          const home = ctx.platform.paths.appHome(slug);
          const queue = await loadQueue(ctx.platform, home);
          const rows = queue.jobs.map((j) => [
            j.id,
            j.status,
            j.receivedAt,
            j.finishedAt ?? "",
            j.error ?? "",
          ]);
          ui.table(["id", "status", "received", "finished", "error"], rows);
        }
      } else if (action === "drain") {
        const state = await ctx.store.load();
        const app = state.apps[slug];
        if (!app) {
          ui.error(`app not found: ${slug}`);
        } else {
          const home = ctx.platform.paths.appHome(slug);
          const job = await drainDeploy(ctx.platform, app, home);
          if (!job) ui.info("No job drained");
          else ui.success(`Drained ${job.id}`, `status=${job.status}`);
        }
      } else if (action === "instructions") {
        const state = await ctx.store.load();
        const app = state.apps[slug];
        if (!app?.deploy.enabled) {
          ui.error("Deploy not enabled for this app");
        } else {
          ui.message(
            deployWebhookInstructions(
              app,
              app.deploy.hmacSecret ? "<stored in state>" : "",
            ),
          );
        }
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function sectionCron(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Cron jobs");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Cron", [
      { label: "List jobs", value: "list" },
      { label: "Add job", value: "add" },
      { label: "Remove job", value: "remove" },
    ]);
    if (!action) return;

    if (action === "list") {
      const filter = await ui.confirm("Filter by one app?", { defaultYes: false });
      const app = filter ? await pickApp(ui, ctx) : undefined;
      if (filter && !app) continue;
      const state = await ctx.store.load();
      const rows = listCronJobs(state, app ?? undefined).map((j) => [
        j.app,
        j.name,
        j.schedule,
        j.command.join(" "),
        j.enabled ? "yes" : "no",
      ]);
      ui.table(["app", "name", "schedule", "command", "enabled"], rows);
      await ui.pause();
    } else if (action === "add") {
      const app = await pickApp(ui, ctx);
      if (!app) continue;
      const name = await ui.prompt("Job name", { required: true });
      if (!name) continue;
      const schedule = await ui.prompt("Cron schedule", {
        required: true,
        default: "*/5 * * * *",
      });
      if (!schedule) continue;
      const cmdRaw = await ui.prompt("Command (space-separated argv)", {
        required: true,
        default: "php artisan schedule:run",
      });
      if (!cmdRaw) continue;
      const timezone = await ui.prompt("Timezone (blank = default)", { default: "" });
      if (timezone === null) continue;
      const command = cmdRaw.split(/\s+/).filter(Boolean);
      try {
        await ctx.store.withExclusive(async (state) => {
          const r = addCronJob(state, {
            app,
            name,
            schedule,
            command,
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
        ui.success(`Added cron ${name}`, `app=${app} schedule=${schedule}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "remove") {
      const state = await ctx.store.load();
      const jobs = listCronJobs(state);
      if (jobs.length === 0) {
        ui.info("No cron jobs");
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        "Remove cron job",
        jobs.map((j) => ({
          label: `${j.app}/${j.name}`,
          value: `${j.app}\0${j.name}`,
          hint: j.schedule,
        })),
      );
      if (!picked) continue;
      const [app, name] = picked.split("\0");
      if (!(await ui.confirm(`Remove cron ${name} for ${app}?`))) continue;
      try {
        await ctx.store.withExclusive(async (s) => {
          const r = removeCronJob(s, app!, name!, ctx.platform.clock.nowIso());
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Removed cron ${name}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    }
  }
}

async function sectionWorker(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Workers");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Workers", [
      { label: "List workers", value: "list" },
      { label: "Add worker", value: "add" },
      { label: "Remove worker", value: "remove" },
      { label: "Start worker", value: "start" },
      { label: "Stop worker", value: "stop" },
      { label: "Restart worker", value: "restart" },
      { label: "Inspect worker", value: "inspect" },
    ]);
    if (!action) return;

    if (action === "list") {
      const filter = await ui.confirm("Filter by one app?", { defaultYes: false });
      const app = filter ? await pickApp(ui, ctx) : undefined;
      if (filter && !app) continue;
      const state = await ctx.store.load();
      const rows = listWorkers(state, app ?? undefined).map((w) => [
        w.app,
        w.name,
        w.command.join(" "),
        w.enabled ? "yes" : "no",
      ]);
      ui.table(["app", "name", "command", "enabled"], rows);
      await ui.pause();
    } else if (action === "add") {
      const app = await pickApp(ui, ctx);
      if (!app) continue;
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
          const r = addWorker(state, { app, name, command }, ctx.platform);
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Added worker ${name}`, `app=${app}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "remove") {
      const state = await ctx.store.load();
      const workers = listWorkers(state);
      if (workers.length === 0) {
        ui.info("No workers");
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        "Remove worker",
        workers.map((w) => ({
          label: `${w.app}/${w.name}`,
          value: `${w.app}\0${w.name}`,
          hint: w.command.join(" "),
        })),
      );
      if (!picked) continue;
      const [app, name] = picked.split("\0");
      if (!(await ui.confirm(`Remove worker ${name} for ${app}?`))) continue;
      try {
        await ctx.store.withExclusive(async (s) => {
          const r = removeWorker(s, app!, name!, ctx.platform.clock.nowIso());
          await ctx.store.save(r.state);
          await ctx.render.apply(r.state, {
            reloadPlan: r.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return r;
        });
        ui.success(`Removed worker ${name}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (
      action === "start" || action === "stop" || action === "restart" ||
      action === "inspect"
    ) {
      const state = await ctx.store.load();
      const workers = listWorkers(state);
      if (workers.length === 0) {
        ui.info("No workers");
        await ui.pause();
        continue;
      }
      const picked = await ui.menu(
        `${action} worker`,
        workers.map((w) => ({
          label: `${w.app}/${w.name}`,
          value: `${w.app}\0${w.name}`,
          hint: w.command.join(" "),
        })),
      );
      if (!picked) continue;
      const [app, name] = picked.split("\0");
      try {
        if (action === "inspect") {
          const result = await inspectWorker(ctx.platform, state, app!, name!);
          ui.message(
            [
              `program: ${result.plan.program}`,
              `runner: ${result.plan.runnerService}`,
              `status: ${result.stdout.trim() || result.stderr.trim() || "(no output)"}`,
            ].join("\n"),
          );
        } else {
          const plan = buildWorkerControlPlan(
            state,
            app!,
            name!,
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

async function sectionLogs(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Access logs");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Access logs", [
      { label: "Enable for app", value: "enable", hint: "nginx-only reload" },
      { label: "Disable for app", value: "disable", hint: "preserves files" },
      { label: "Rotate + reopen", value: "rotate" },
      { label: "GoAccess report (dry-run)", value: "report" },
    ]);
    if (!action) return;

    const slug = await pickApp(ui, ctx);
    if (!slug) continue;

    try {
      if (action === "enable" || action === "disable") {
        const enabled = action === "enable";
        await ctx.store.withExclusive(async (state) => {
          const mutation = setAppAccessLog(
            state,
            slug,
            enabled,
            ctx.platform.clock.nowIso(),
            ctx.platform,
          );
          await ctx.store.save(mutation.state);
          await ctx.render.apply(mutation.state, {
            reloadPlan: mutation.reloadPlan,
            skipValidate: true,
            alreadyLocked: true,
          });
          return mutation;
        });
        ui.success(
          enabled ? `Access logs enabled for ${slug}` : `Access logs disabled for ${slug}`,
        );
      } else if (action === "rotate") {
        const state = await ctx.store.load();
        const result = await rotateAccessLog(ctx.platform, state, slug);
        ui.success(
          result.rotated
            ? `Rotated to ${result.plan.rotatedPath}`
            : "No active log; reopen attempted",
        );
      } else if (action === "report") {
        const state = await ctx.store.load();
        try {
          const plan = await generateAccessReport(ctx.platform, state, slug, {
            dryRun: true,
          });
          ui.message(plan.command.join(" "));
        } catch (err) {
          handleError(ui, err);
        }
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function sectionTemplate(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Templates");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const action = await ui.menu("Templates", [
      { label: "Select custom template", value: "select" },
      { label: "Return to upstream", value: "return" },
      { label: "Check upstream drift", value: "drift" },
    ]);
    if (!action) return;

    try {
      if (action === "drift") {
        const state = await ctx.store.load();
        const drifts = await detectTemplateDrift(ctx.platform, state);
        if (drifts.length === 0) ui.info("No custom templates");
        else {
          ui.table(
            ["app", "kind", "status", "source"],
            drifts.map((d) => [
              d.slug,
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

      const slug = await pickApp(ui, ctx);
      if (!slug) continue;
      const kind = await ui.menu<TemplateKind>("Template kind", [
        { label: "Nginx vhost", value: "vhost" },
        { label: "PHP-FPM pool", value: "pool" },
      ]);
      if (!kind) continue;

      if (action === "select") {
        const source = await ui.prompt("Path to custom template source", {
          required: true,
        });
        if (!source) continue;
        const result = await ctx.store.withExclusive(async (state) => {
          const selected = await selectCustomTemplate(ctx.platform, state, {
            slug,
            kind,
            sourcePath: source,
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

async function sectionMaintenance(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Maintenance");
  ui.note([
    "Host maintenance (this menu) is separate from in-runner logrotate",
    "(supervisord program system-logrotate).",
  ]);

  while (true) {
    const action = await ui.menu("Maintenance", [
      { label: "Run log retention now", value: "run" },
      {
        label: "Register host cron",
        value: "register",
        hint: "scriptable: bento maintenance register",
      },
      {
        label: "Unregister host cron",
        value: "unregister",
        hint: "scriptable: bento maintenance unregister",
      },
    ]);
    if (!action) return;

    try {
      if (action === "run") {
        const daysRaw = await ui.prompt("Retain rotated logs (days)", {
          default: "14",
        });
        const retainDays = Number(daysRaw ?? "14");
        const result = await runStackMaintenance(ctx.platform, { retainDays });
        for (const n of result.notes) ui.message(n);
        ui.success(`Removed ${result.removed.length} file(s)`);
      } else {
        ui.info(
          action === "register"
            ? "Use: bento maintenance register [--schedule '15 3 * * *']"
            : "Use: bento maintenance unregister",
        );
        ui.message("Host crontab merge preserves unrelated entries.");
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function sectionTls(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("TLS");
  if (!(await ensureState(ui, ctx))) return;

  const targetKind = await ui.menu<"app" | "proxy">("TLS target", [
    { label: "Application", value: "app" },
    { label: "Reverse proxy", value: "proxy" },
  ]);
  if (!targetKind) return;

  let targetName: string | null = null;
  if (targetKind === "app") {
    targetName = await pickApp(ui, ctx);
  } else {
    const state = await ctx.store.load();
    const proxies = Object.values(state.proxies);
    if (proxies.length === 0) {
      ui.warn("No proxies defined");
      await ui.pause();
      return;
    }
    targetName = await ui.menu(
      "Select proxy",
      proxies.map((p) => ({
        label: p.name,
        value: p.name,
        hint: p.mainDomain,
      })),
    );
  }
  if (!targetName) return;

  const mode = await ui.menu<"boot" | "acme" | "external">("TLS mode", [
    { label: "Boot (self-signed starter)", value: "boot" },
    { label: "ACME (Let's Encrypt)", value: "acme" },
    { label: "External certificate files", value: "external" },
  ]);
  if (!mode) return;

  let tls: TlsMode;
  if (mode === "boot") {
    tls = { kind: "boot" };
  } else if (mode === "acme") {
    const email = await ui.prompt("ACME contact email (optional)", { default: "" });
    if (email === null) return;
    tls = { kind: "acme", ...(email ? { email } : {}) };
  } else {
    const cert = await ui.prompt("Certificate path", { required: true });
    if (!cert) return;
    const key = await ui.prompt("Private key path", { required: true });
    if (!key) return;
    tls = { kind: "external", certPath: cert, keyPath: key };
  }

  try {
    await ctx.store.withExclusive(async (state) => {
      const now = ctx.platform.clock.nowIso();
      let next = state;
      if (targetKind === "app") {
        const app = state.apps[targetName!];
        if (!app) throw new Error(`app not found: ${targetName}`);
        next = {
          ...state,
          apps: { ...state.apps, [targetName!]: { ...app, tls, updatedAt: now } },
          updatedAt: now,
        };
      } else {
        const proxy = state.proxies[targetName!];
        if (!proxy) throw new Error(`proxy not found: ${targetName}`);
        next = {
          ...state,
          proxies: { ...state.proxies, [targetName!]: { ...proxy, tls, updatedAt: now } },
          updatedAt: now,
        };
      }
      await ctx.store.save(next);
      await ctx.render.apply(next, {
        reloadPlan: { nginx: true, phpFpm: new Set(), phpRunner: new Set() },
        skipValidate: true,
        alreadyLocked: true,
      });
      return next;
    });
    ui.success(`TLS mode set to ${mode}`, `${targetKind}:${targetName}`);
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}

async function sectionPermissions(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Permissions");
  if (!(await ensureState(ui, ctx))) return;

  const action = await ui.menu("Permissions", [
    { label: "Check policy", value: "check" },
    { label: "Repair policy", value: "repair" },
  ]);
  if (!action) return;

  const slug = await pickApp(ui, ctx);
  if (!slug) return;
  const recursive = await ui.confirm("Recursive scan?", { defaultYes: false });

  try {
    const state = await ctx.store.load();
    if (action === "check") {
      const report = await checkPermissions(ctx.platform, state, slug, { recursive });
      ui.blank();
      ui.message(formatPermReport(report));
      if (report.issues.length) ui.warn(`${report.issues.length} issue(s) found`);
      else ui.success("Permissions look good");
    } else {
      const dryRun = await ui.confirm("Dry-run only?", { defaultYes: false });
      const result = await repairPermissions(ctx.platform, state, slug, {
        dryRun,
        recursive,
        shallow: !recursive,
      });
      for (const a of result.actions) ui.info(a);
      ui.blank();
      ui.message(formatPermReport(result.report));
      ui.success(dryRun ? "Dry-run complete" : "Repair complete");
    }
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}

async function sectionBackup(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Backup / restore");
  if (!(await ensureState(ui, ctx))) return;

  const action = await ui.menu("Backup & restore", [
    { label: "Backup", value: "backup", hint: "in-container dump over MySQL socket" },
    { label: "Restore", value: "restore", hint: "non-atomic import" },
  ]);
  if (!action) return;

  if (action === "backup") {
    const scope = await ui.menu<"app" | "database" | "all">("Backup scope", [
      { label: "All managed databases", value: "all" },
      { label: "One app (all its DBs)", value: "app" },
      { label: "Single database", value: "database" },
    ]);
    if (!scope) return;

    let slug: string | undefined;
    let database: string | undefined;
    if (scope !== "all") {
      const picked = await pickApp(ui, ctx);
      if (!picked) return;
      slug = picked;
    }
    if (scope === "database") {
      const db = await ui.prompt("Database name", { required: true });
      if (!db) return;
      database = db;
    }
    const compress = await ui.menu<"zstd" | "gzip" | "none">("Compression", [
      { label: "zstd (default)", value: "zstd" },
      { label: "gzip", value: "gzip" },
      { label: "none", value: "none" },
    ]);
    if (!compress) return;

    try {
      const state = await ctx.store.load();
      const artifacts = await runBackup(ctx.platform, state, {
        scope,
        slug,
        database,
        compress,
      });
      if (artifacts.length === 0) ui.warn("No databases backed up");
      for (const a of artifacts) {
        ui.success(`backup ${a.database}`, `${a.path} (${a.bytes} bytes)`);
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
    return;
  }

  // restore
  ui.warn(
    "Restore is not object-level atomic",
    "A failed import can leave a partial destination database.",
  );
  type RestoreSource = { kind: "backup"; path: string } | { kind: "path" };
  const recent = await listRecentBackupFiles(ctx.platform, 20).catch((err) => {
    handleError(ui, err);
    return [];
  });
  const sourceRows: TableMenuChoice<RestoreSource>[] = recent.map((backup) => ({
    columns: [
      relative(ctx.platform.paths.paths.backupsDir, backup.path) || backup.path,
      formatBackupDate(backup.createdAt),
      formatHumanSize(backup.bytes),
    ],
    value: { kind: "backup", path: backup.path },
  }));
  sourceRows.push({
    columns: ["Path of file…", "", ""],
    value: { kind: "path" },
  });

  const source = await ui.tableMenu(
    "Choose dump file",
    ["Backup file (latest 20)", "Created", "Size"],
    sourceRows,
  );
  if (!source) return;
  const file = source.kind === "backup"
    ? source.path
    : await ui.prompt("Dump file path", { required: true });
  if (!file) return;

  const slug = await pickApp(ui, ctx, { title: "Target app (ownership)" });
  if (!slug) return;
  const target = await ui.prompt("Target database name", { required: true });
  if (!target) return;
  const replace = await ui.confirm(
    "Replace an existing database with this exact name? (requires confirmation)",
    { defaultYes: false },
  );
  let replaceName: string | undefined;
  if (replace) {
    const confirmName = await ui.prompt(`Type the exact target name "${target}" to confirm`);
    if (confirmName !== target) {
      ui.error("Confirmation did not match; aborting");
      await ui.pause();
      return;
    }
    replaceName = target;
  }
  if (!(await ui.confirm("Proceed with restore?"))) {
    ui.info("Cancelled");
    await ui.pause();
    return;
  }
  try {
    const state = await ctx.store.load();
    await runRestore(ctx.platform, state, {
      file,
      slug,
      targetDatabase: target,
      replaceOriginal: replaceName,
    });
    ui.success(`Restore completed into ${target}`);
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}

async function sectionCompose(ui: WizardUI, ctx: CliContext): Promise<void> {
  ui.header("Compose helpers");
  if (!(await ensureState(ui, ctx))) return;

  const action = await ui.menu("Docker Compose", [
    { label: "Print compose argv for a command", value: "print" },
    { label: "ps", value: "ps" },
    { label: "logs (follow off)", value: "logs" },
    { label: "Custom safe args", value: "custom", hint: "refuses down -v" },
  ]);
  if (!action) return;

  let command: string[] = [];
  if (action === "ps") command = ["ps"];
  else if (action === "logs") command = ["logs", "--tail", "100"];
  else if (action === "print" || action === "custom") {
    const raw = await ui.prompt("Compose args (space-separated)", {
      required: true,
      default: action === "print" ? "config --services" : "ps",
    });
    if (!raw) return;
    command = raw.split(/\s+/).filter(Boolean);
  }

  try {
    assertSafeComposeArgs(command);
    const state = await ctx.store.load();
    const { materializeDockerAssets } = await import("../services/assets_materialize.ts");
    await materializeDockerAssets(
      ctx.platform,
      state.phpVersions.map((v) => String(v.version)),
    );
    await ctx.render.apply(state, { renderOnly: true, skipValidate: true });
    const full = await composeArgs(ctx.platform, state, command);

    if (action === "print") {
      ui.success("Compose argv");
      ui.message(full.join(" "));
      await ui.pause();
      return;
    }

    ui.info(`running: docker compose ${command.join(" ")}`);
    ui.blank();
    const [cmd, ...cmdArgs] = full;
    const child = new Deno.Command(cmd!, {
      args: cmdArgs,
      cwd: ctx.stackRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.output();
    ui.blank();
    if (status.code === 0) ui.success("Compose command finished");
    else ui.error(`Compose exited with code ${status.code}`);
  } catch (err) {
    handleError(ui, err);
  }
  await ui.pause();
}
