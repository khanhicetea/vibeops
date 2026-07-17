/**
 * Interactive wizard (TUI) for Bento operator workflows.
 * Guided numbered menus over the same services as scripted CLI commands.
 */

import { isBentoError } from "../domain/errors.ts";
import type { TlsMode } from "../domain/state.ts";
import { FPM_PROFILES } from "../domain/types.ts";
import { describeReloadPlan } from "../domain/reload.ts";
import { capacityWarnings, materializeAppHome, provisionApp } from "../services/app.ts";
import { addPhpVersion, listPhpVersions, removePhpVersion } from "../services/php.ts";
import {
  addMysqlVersion,
  createAppDatabase,
  listMysqlVersions,
  rotateAppPassword,
  runBackup,
  runRestore,
} from "../services/mysql.ts";
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
import { addWorker, listWorkers, removeWorker } from "../services/worker.ts";
import { buildStatus, formatStatus } from "../services/status.ts";
import { checkPermissions, formatPermReport, repairPermissions } from "../services/permissions.ts";
import { assertSafeComposeArgs, composeArgs } from "../services/compose.ts";
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
        { label: "Status & diagnostics", value: "status", hint: "stack / apps / capacity" },
        { label: "Bootstrap", value: "bootstrap", hint: "init · render · apply" },
        { label: "Applications", value: "apps", hint: "create · list · show" },
        { label: "PHP versions", value: "php", hint: "add · remove · list" },
        { label: "MySQL", value: "mysql", hint: "versions · databases · password" },
        { label: "Reverse proxies", value: "proxy", hint: "create · list" },
        { label: "Deploy webhooks", value: "deploy", hint: "enable · rotate · drain" },
        { label: "Cron jobs", value: "cron", hint: "add · remove · list" },
        { label: "Workers", value: "worker", hint: "add · remove · list" },
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
    ui.warn("Stack not initialized", `Run Bootstrap → Initialize, or: bento --stack ${ctx.stackRoot} init`);
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
    { label: "Render only (skip service signals)", value: "apply-ro", hint: "bento apply --render-only" },
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
    }
  }
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
      await materializeAppHome(ctx.platform, provisioned.app, true);
      await ctx.store.save(provisioned.state);
      if (!noApply) {
        await ctx.render.apply(provisioned.state, {
          reloadPlan: provisioned.reloadPlan,
          skipValidate: false,
          alreadyLocked: true,
        });
      }
      return provisioned;
    });
    ui.success(
      `${result.created ? "Created" : "Updated"} app ${result.app.slug}`,
      `uid=${result.app.uid} domain=${result.app.mainDomain}`,
    );
    for (const w of capacityWarnings(result.state)) ui.warn(w);
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
      { label: "Rotate app password", value: "password", hint: "printed once" },
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
          const next = createAppDatabase(state, slug, dbName, ctx.platform.clock.nowIso());
          await ctx.store.save(next);
          return next;
        });
        ui.success(`Recorded database ${dbName}`, `app=${slug}`);
      } catch (err) {
        handleError(ui, err);
      }
      await ui.pause();
    } else if (action === "password") {
      const slug = await pickApp(ui, ctx);
      if (!slug) continue;
      ui.warn("Password will be printed once below");
      if (!(await ui.confirm(`Rotate MySQL password for ${slug}?`))) continue;
      try {
        const result = await ctx.store.withExclusive(async (state) => {
          const rotated = rotateAppPassword(ctx.platform, state, slug);
          await ctx.store.save(rotated.state);
          return rotated;
        });
        ui.success("Password rotated (copy now)");
        ui.blank();
        ui.message(result.password);
        ui.blank();
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
    }
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
    { label: "Backup", value: "backup", hint: "requires MYSQL_ROOT_PASSWORD" },
    { label: "Restore", value: "restore", hint: "non-atomic import" },
  ]);
  if (!action) return;

  if (action === "backup") {
    const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
    if (!rootPassword) {
      ui.error("MYSQL_ROOT_PASSWORD must be set in the environment");
      await ui.pause();
      return;
    }
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
      }, rootPassword);
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
  const rootPassword = Deno.env.get("MYSQL_ROOT_PASSWORD");
  if (!rootPassword) {
    ui.error("MYSQL_ROOT_PASSWORD must be set");
    await ui.pause();
    return;
  }
  const file = await ui.prompt("Dump file path", { required: true });
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
    }, rootPassword);
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
