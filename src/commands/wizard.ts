/**
 * Interactive wizard (TUI) for Bento operator workflows.
 * Guided numbered menus over the same services as scripted CLI commands.
 */

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
import { addPhpVersion, listPhpVersions } from "../services/php.ts";
import {
  addMysqlVersion,
  buildMysqlShellPlan,
  createAppDatabaseLive,
  listMysqlVersions,
  type MysqlShellPlan,
  queryDatabaseSizes,
  resolveMysqlServices,
} from "../services/mysql.ts";
import { loadRedisPassword, requireMysqlRootPassword } from "../services/stack_env.ts";
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
import { buildStatus, formatStatus } from "../services/status.ts";
import { redact } from "../ui/output.ts";
import { type MenuChoice, WizardUI } from "../ui/tui.ts";
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
        {
          label: "Manage app",
          value: "apps",
          hint: "databases · cron jobs · workers · domains · logs · templates",
        },
        { label: "Manage MySQL", value: "mysql", hint: "shell · add version · database sizes" },
        { label: "Manage PHP", value: "php", hint: "add version · reload FPM" },
        { label: "Status / Diag", value: "status", hint: "stack · apps · capacity" },
        { label: "Bootstrap", value: "bootstrap", hint: "init · render · apply" },
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

function handleError(ui: WizardUI, err: unknown): void {
  if (isBentoError(err)) {
    ui.error(redact(err.message), err.recovery ? `recovery: ${err.recovery}` : undefined);
    return;
  }
  ui.error(redact(err instanceof Error ? err.message : String(err)));
}

async function dispatch(ui: WizardUI, ctx: CliContext, section: string): Promise<void> {
  const map: Record<string, WizardAction> = {
    apps: () => sectionApps(ui, ctx),
    mysql: () => sectionMysql(ui, ctx),
    php: () => sectionPhp(ui, ctx),
    status: () => sectionStatus(ui, ctx),
    bootstrap: () => sectionBootstrap(ui, ctx),
  };
  const fn = map[section];
  if (fn) await fn();
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
  ui.header("Manage app");
  if (!(await ensureState(ui, ctx))) return;

  while (true) {
    const state = await ctx.store.load();
    const choices: MenuChoice<string>[] = Object.values(state.apps)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((app) => ({
        label: app.slug,
        value: app.slug,
        hint: `${app.mainDomain} · php ${app.phpVersion}`,
      }));
    choices.push({ label: "Create application…", value: "__create" });

    const slug = await ui.menu("Select application", choices);
    if (!slug) return;
    if (slug === "__create") {
      await wizardAppCreate(ui, ctx);
      continue;
    }

    while (true) {
      const current = (await ctx.store.load()).apps[slug];
      if (!current) break;
      ui.clear();
      ui.header(`App: ${slug}`, `${current.mainDomain} · php ${current.phpVersion}`);
      const action = await ui.menu("Manage application", [
        { label: "Databases", value: "databases", hint: "list · create · shell" },
        { label: "Cron jobs", value: "cron", hint: "list · add · remove" },
        { label: "Workers", value: "workers", hint: "list · add · control" },
        { label: "Domains", value: "domains", hint: "primary · aliases · TLS" },
        { label: "Access logs", value: "logs", hint: "enable · rotate · report" },
        { label: "Templates", value: "templates", hint: "vhost · FPM pool · drift" },
      ]);
      if (!action) break;

      if (action === "databases") await sectionAppDatabases(ui, ctx, slug);
      else if (action === "cron") await sectionCron(ui, ctx, slug);
      else if (action === "workers") await sectionWorker(ui, ctx, slug);
      else if (action === "domains") await sectionAppDomains(ui, ctx, slug);
      else if (action === "logs") await sectionLogs(ui, ctx, slug);
      else if (action === "templates") await sectionTemplate(ui, ctx, slug);
    }
  }
}

/** Attach interactive ephemeral PHP CLI shell as the selected app identity. */
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

async function openMysqlShell(
  ui: WizardUI,
  ctx: CliContext,
  plan: MysqlShellPlan,
  scriptable: string,
): Promise<void> {
  ui.blank();
  ui.info(
    `Attaching MySQL shell to ${plan.service} as ${plan.user}${
      plan.database ? ` · database=${plan.database}` : ""
    }`,
  );
  ui.message(pcDim(`scriptable: ${scriptable}`));
  ui.message(pcDim("Exit the MySQL client to return to the wizard."));
  ui.blank();

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
      return;
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
  if (exitCode === 0) ui.success("MySQL shell closed", plan.service);
  else ui.warn(`MySQL shell exited ${exitCode}`, plan.service);
}

async function sectionAppDatabases(
  ui: WizardUI,
  ctx: CliContext,
  slug: string,
): Promise<void> {
  while (true) {
    ui.clear();
    ui.header(`Databases: ${slug}`);
    const action = await ui.menu("Databases", [
      { label: "List databases", value: "list" },
      { label: "Create database", value: "create" },
      { label: "Open MySQL shell", value: "shell", hint: `as app ${slug}` },
    ]);
    if (!action) return;

    try {
      if (action === "list") {
        const app = (await ctx.store.load()).apps[slug];
        if (!app) throw new Error(`app not found: ${slug}`);
        ui.table(
          ["database", "created"],
          app.databases.map((db) => [db.name, db.createdAt]),
        );
      } else if (action === "create") {
        const dbName = await ui.prompt("Database name", {
          required: true,
          default: slug,
        });
        if (!dbName) continue;
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
      } else {
        const state = await ctx.store.load();
        const app = state.apps[slug];
        if (!app) throw new Error(`app not found: ${slug}`);
        await openMysqlShell(
          ui,
          ctx,
          buildMysqlShellPlan(ctx.platform, { kind: "app", app }),
          `bento mysql shell --app ${slug}`,
        );
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function sectionAppDomains(
  ui: WizardUI,
  ctx: CliContext,
  slug: string,
): Promise<void> {
  while (true) {
    const app = (await ctx.store.load()).apps[slug];
    if (!app) return;
    ui.clear();
    ui.header(`Domains: ${slug}`, `${app.mainDomain} · TLS ${app.tls.kind}`);
    const action = await ui.menu("Domains", [
      { label: "Show domains", value: "show" },
      { label: "Update primary domain / aliases", value: "update" },
      { label: "Configure TLS", value: "tls" },
    ]);
    if (!action) return;

    if (action === "show") {
      ui.table(
        ["kind", "domain"],
        [["primary", app.mainDomain], ...app.aliases.map((alias) => ["alias", alias])],
      );
      await ui.pause();
      continue;
    }

    try {
      if (action === "update") {
        const domain = await ui.prompt("Primary domain", {
          required: true,
          default: app.mainDomain,
        });
        if (!domain) continue;
        const aliasesRaw = await ui.prompt("Aliases (comma-separated)", {
          default: app.aliases.join(","),
        });
        if (aliasesRaw === null) continue;
        const aliases = aliasesRaw.split(",").map((value) => value.trim()).filter(Boolean);
        await ctx.store.withExclusive(async (state) => {
          const result = provisionApp(ctx.platform, state, { slug, domain, aliases });
          await ctx.store.save(result.state);
          await ctx.render.apply(result.state, {
            reloadPlan: { nginx: true, phpFpm: new Set(), phpRunner: new Set() },
            skipValidate: false,
            alreadyLocked: true,
          });
          return result;
        });
        ui.success(`Updated domains for ${slug}`, [domain, ...aliases].join(", "));
      } else {
        const mode = await ui.menu<"boot" | "acme" | "external">("TLS mode", [
          { label: "Boot (self-signed starter)", value: "boot" },
          { label: "ACME (Let's Encrypt)", value: "acme" },
          { label: "External certificate files", value: "external" },
        ]);
        if (!mode) continue;

        let tls: TlsMode;
        if (mode === "boot") {
          tls = { kind: "boot" };
        } else if (mode === "acme") {
          const email = await ui.prompt("ACME contact email (optional)", { default: "" });
          if (email === null) continue;
          tls = { kind: "acme", ...(email ? { email } : {}) };
        } else {
          const cert = await ui.prompt("Certificate path", { required: true });
          if (!cert) continue;
          const key = await ui.prompt("Private key path", { required: true });
          if (!key) continue;
          tls = { kind: "external", certPath: cert, keyPath: key };
        }

        await ctx.store.withExclusive(async (state) => {
          const current = state.apps[slug];
          if (!current) throw new Error(`app not found: ${slug}`);
          const now = ctx.platform.clock.nowIso();
          const next = {
            ...state,
            apps: { ...state.apps, [slug]: { ...current, tls, updatedAt: now } },
            updatedAt: now,
          };
          await ctx.store.save(next);
          await ctx.render.apply(next, {
            reloadPlan: { nginx: true, phpFpm: new Set(), phpRunner: new Set() },
            skipValidate: true,
            alreadyLocked: true,
          });
          return next;
        });
        ui.success(`TLS mode set to ${mode}`, `app:${slug}`);
      }
    } catch (err) {
      handleError(ui, err);
    }
    await ui.pause();
  }
}

async function sectionPhp(ui: WizardUI, ctx: CliContext): Promise<void> {
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

async function sectionMysql(ui: WizardUI, ctx: CliContext): Promise<void> {
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

async function sectionCron(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
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

async function sectionWorker(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Workers: ${slug}`);

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
      action === "inspect"
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
          const plan = buildWorkerControlPlan(
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

async function sectionLogs(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Access logs: ${slug}`);

  while (true) {
    const action = await ui.menu("Access logs", [
      { label: "Enable", value: "enable", hint: "nginx-only reload" },
      { label: "Disable", value: "disable", hint: "preserves files" },
      { label: "Rotate + reopen", value: "rotate" },
      { label: "GoAccess report (dry-run)", value: "report" },
    ]);
    if (!action) return;

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

async function sectionTemplate(ui: WizardUI, ctx: CliContext, slug: string): Promise<void> {
  ui.header(`Templates: ${slug}`);

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
