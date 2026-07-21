/**
 * Application provisioning and lifecycle.
 */

import { join } from "@std/path";
import type { AppState, DesiredState, EntrypointMode, TlsMode } from "../domain/state.ts";
import { defaultDeployConfig, defaultRedisIdentity, mysqlServiceName } from "../domain/state.ts";
import {
  asAbsoluteAppPath,
  asAppSlug,
  asDomainName,
  asFpmProfile,
  asGid,
  asMysqlService,
  asPhpVersion,
  asUid,
  DEFAULT_FPM_PROFILE,
  DEFAULT_UID_BASE,
  FPM_PROFILES,
  type FpmProfile,
  type PhpVersion,
} from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import {
  parseAppSlug,
  parseDomainName,
  parsePhpVersion,
  parseSafeRelativePath,
  unwrap,
} from "../schemas/validators.ts";
import type { Platform } from "../platform/mod.ts";
import { containerAppHome } from "../platform/paths.ts";
import {
  mergeReloadPlans,
  type ReloadPlan,
  reloadPlanForPoolChange,
  reloadPlanForRunnerChange,
} from "../domain/reload.ts";
import { applyAppPermissionPolicy } from "./permissions.ts";
import { applyAppMysqlGrants, isMysqlReachable, tryBestEffortMysqlAccount } from "./mysql.ts";
import { tryApplyAppRedisAcl } from "./redis.ts";
import { loadMysqlRootPassword, loadRedisPassword, requireMysqlRootPassword } from "./stack_env.ts";
import { serviceError } from "../domain/errors.ts";

export type ProvisionAppInput = {
  slug: string;
  domain: string;
  aliases?: string[];
  documentRoot?: string;
  entrypointMode?: EntrypointMode;
  phpVersion?: string;
  fpmProfile?: string;
  mysqlVersion?: string;
  createDatabase?: boolean;
  databaseName?: string;
  tls?: TlsMode;
  accessLog?: boolean;
};

export type ProvisionAppResult = {
  state: DesiredState;
  app: AppState;
  reloadPlan: ReloadPlan;
  created: boolean;
};

export function provisionApp(
  platform: Platform,
  state: DesiredState,
  input: ProvisionAppInput,
): ProvisionAppResult {
  const slug = unwrap(parseAppSlug(input.slug), "slug");
  const domain = unwrap(parseDomainName(input.domain), "domain");
  const aliases = (input.aliases ?? []).map((a, i) => unwrap(parseDomainName(a), `aliases[${i}]`));

  const existing = state.apps[slug];
  const created = !existing;

  // Domain uniqueness
  const claimed = [domain, ...aliases];
  for (const d of claimed) {
    const owner = state.domains[d];
    if (!owner) continue;
    if (owner.kind === "app" && owner.slug === slug) continue;
    throw conflictError(
      `domain ${d} is already owned by ${
        owner.kind === "app" ? `app ${owner.slug}` : `proxy ${owner.name}`
      }`,
    );
  }

  // Runtime selection: omitted choices preserve existing recorded runtime
  const phpVersionStr = input.phpVersion
    ? unwrap(parsePhpVersion(input.phpVersion), "phpVersion")
    : existing?.phpVersion ?? state.defaults.phpVersion;
  const phpVersion = asPhpVersion(String(phpVersionStr));
  const managedPhp = state.phpVersions.find((v) => v.version === phpVersion);
  if (!managedPhp) {
    throw validationError(
      `PHP version ${phpVersion} is not managed. Add it first.`,
    );
  }

  const fpmProfileStr = input.fpmProfile ??
    existing?.fpmProfile ??
    state.defaults.fpmProfile;
  if (!(String(fpmProfileStr) in FPM_PROFILES)) {
    throw validationError(
      `unknown FPM profile ${fpmProfileStr}; choose one of: ${
        Object.keys(FPM_PROFILES).join(", ")
      }`,
    );
  }
  const fpmProfile = asFpmProfile(String(fpmProfileStr));

  const mysqlVersion = input.mysqlVersion
    ? input.mysqlVersion
    : existing
    ? undefined
    : state.defaults.mysqlVersion;
  let mysqlService = existing?.mysqlService;
  if (mysqlVersion) {
    const mv = state.mysqlVersions.find((m) => m.version === mysqlVersion);
    if (!mv) {
      throw validationError(`MySQL version ${mysqlVersion} is not managed`);
    }
    if (existing && existing.mysqlService !== mv.service) {
      throw conflictError(
        `app ${slug} is assigned to ${existing.mysqlService}; moving MySQL versions is an explicit migration`,
      );
    }
    mysqlService = mv.service;
  }
  if (!mysqlService) {
    mysqlService = mysqlServiceName(state.defaults.mysqlVersion);
  }
  const managedMysql = state.mysqlVersions.find((m) => m.service === mysqlService);
  if (!managedMysql) {
    throw validationError(`MySQL service ${mysqlService} is not managed`);
  }

  // Explicit database request must fail if MySQL unavailable — checked by caller with live check.
  // Here we only record intent.

  const documentRoot = unwrap(
    parseSafeRelativePath(input.documentRoot ?? existing?.documentRoot ?? "public"),
    "documentRoot",
  );
  const entrypointMode: EntrypointMode = input.entrypointMode ??
    existing?.entrypointMode ??
    "front-controller";
  const tls: TlsMode = input.tls ?? existing?.tls ?? { kind: "shared" };
  const accessLog = input.accessLog ?? existing?.accessLog ?? false;

  // Stable UID/GID
  const { uid, gid } = existing
    ? { uid: existing.uid, gid: existing.gid }
    : allocateIdentity(state);

  const homeContainer = containerAppHome(slug);
  const now = platform.clock.nowIso();

  // Generate once for a new app; all later reconciliation preserves it.
  const mysqlPassword = existing?.mysqlPassword ?? platform.random.hex(18);
  const redisPassword = existing?.redis.password ??
    (state.defaults.redisMode === "shared" ? undefined : platform.random.hex(18));

  let redis = existing?.redis ??
    defaultRedisIdentity(slug, state.defaults.redisMode);
  if (!existing) {
    redis = {
      ...redis,
      ...(redisPassword ? { password: redisPassword } : {}),
      ...(redis.mode === "acl"
        ? {
          aclPassword: platform.random.hex(18),
          aclUsername: `app_${slug}`,
        }
        : {}),
    };
  }

  const databases = existing?.databases ? [...existing.databases] : [];
  if (input.createDatabase) {
    const dbName = input.databaseName ?? slug;
    if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
      throw validationError(`invalid database name ${dbName}`);
    }
    // Namespace: app databases must start with slug_ or equal slug
    if (dbName !== slug && !dbName.startsWith(`${slug}_`)) {
      throw validationError(
        `database ${dbName} is outside app namespace; use ${slug} or ${slug}_*`,
      );
    }
    if (!databases.some((d) => d.name === dbName)) {
      databases.push({ name: asDatabaseName(dbName), createdAt: now });
    }
  }

  const app: AppState = {
    slug: asAppSlug(slug),
    enabled: existing?.enabled ?? true,
    uid,
    gid,
    home: asAbsoluteAppPath(homeContainer),
    mainDomain: asDomainName(domain),
    aliases: aliases.map(asDomainName),
    documentRoot,
    entrypointMode,
    phpVersion,
    phpService: managedPhp.service,
    fpmProfile,
    tls,
    accessLog,
    mysqlService: asMysqlService(String(mysqlService)),
    mysqlUser: slug,
    mysqlPassword,
    databases,
    redis,
    deploy: existing?.deploy ?? defaultDeployConfig(homeContainer),
    vhostTemplate: existing?.vhostTemplate ?? { kind: "upstream" },
    poolTemplate: existing?.poolTemplate ?? { kind: "upstream" },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // Rebuild domain map for this app
  const domains = { ...state.domains };
  // Remove previous domains owned by this app
  for (const [d, owner] of Object.entries(domains)) {
    if (owner.kind === "app" && owner.slug === slug) delete domains[d];
  }
  for (const d of claimed) {
    domains[d] = { kind: "app", slug: asAppSlug(slug) };
  }

  const next: DesiredState = {
    ...state,
    apps: { ...state.apps, [slug]: app },
    domains,
    updatedAt: now,
  };

  return {
    state: next,
    app,
    reloadPlan: reloadPlanForPoolChange(app.phpService),
    created,
  };
}

function asDatabaseName(name: string): AppState["databases"][number]["name"] {
  return name as AppState["databases"][number]["name"];
}

export function allocateIdentity(
  state: DesiredState,
): { uid: ReturnType<typeof asUid>; gid: ReturnType<typeof asGid> } {
  const used = new Set<number>();
  for (const app of Object.values(state.apps)) {
    used.add(app.uid);
    used.add(app.gid);
  }
  let n = DEFAULT_UID_BASE;
  while (used.has(n)) n++;
  return { uid: asUid(n), gid: asGid(n) };
}

export type MaterializeAppHomeOptions = {
  recursivePerms?: boolean;
  /** Shared Redis password from stack .env (shared mode). */
  redisSharedPassword?: string;
};

/** Create app home directory structure on the host. */
export async function materializeAppHome(
  platform: Platform,
  app: AppState,
  recursivePermsOrOpts: boolean | MaterializeAppHomeOptions = true,
): Promise<void> {
  const opts: MaterializeAppHomeOptions = typeof recursivePermsOrOpts === "boolean"
    ? { recursivePerms: recursivePermsOrOpts }
    : recursivePermsOrOpts;
  const recursivePerms = opts.recursivePerms ?? true;
  const home = platform.paths.appHome(app.slug);
  const dirs = [
    home,
    join(home, "code"),
    join(home, app.documentRoot ? join("code", app.documentRoot) : "code"),
    join(home, "logs"),
    join(home, "tmp"),
    join(home, "tmp", "sessions"),
    join(home, ".bento"),
    join(home, ".ssh"),
    join(home, ".composer"),
    join(home, "credentials"),
  ];
  for (const d of dirs) {
    await platform.fs.mkdirp(d, 0o750);
  }

  // Credentials (mode 0600); shared Redis auth comes from stack env when not on app state.
  const sharedRedisPassword = app.redis.password ?? opts.redisSharedPassword ?? "";
  const redisLines = app.redis.mode === "shared"
    ? [
      `REDIS_PASSWORD=${sharedRedisPassword}`,
      `REDIS_PREFIX=${app.redis.prefix}`,
      `REDIS_MODE=shared`,
    ]
    : [
      `REDIS_USERNAME=${app.redis.aclUsername ?? ""}`,
      `REDIS_PASSWORD=${app.redis.aclPassword ?? ""}`,
      `REDIS_ACL_USERNAME=${app.redis.aclUsername ?? ""}`,
      `REDIS_ACL_PASSWORD=${app.redis.aclPassword ?? ""}`,
      `REDIS_PREFIX=${app.redis.prefix}`,
      `REDIS_MODE=acl`,
    ];
  const cred = [
    `MYSQL_HOST=${app.mysqlService}`,
    `MYSQL_USER=${app.mysqlUser}`,
    `MYSQL_PASSWORD=${app.mysqlPassword}`,
    `MYSQL_DATABASE=${app.databases[0]?.name ?? app.slug}`,
    `REDIS_HOST=redis`,
    `REDIS_PORT=6379`,
    ...redisLines,
    "",
  ].join("\n");
  await platform.fs.atomicWriteText(join(home, "credentials", "app.env"), cred, 0o600);

  // Example deploy hook (exit 99 = skipped)
  const deploySh = join(home, ".bento", "deploy.sh");
  if (!(await platform.fs.exists(deploySh))) {
    await platform.fs.atomicWriteText(
      deploySh,
      `#!/bin/sh\n# Replace this hook with your deploy steps.\n# Exit 0 success, 99 skipped, other failed.\necho "bento: default deploy hook (skipped)" >&2\nexit 99\n`,
      0o750,
    );
  }

  // deploy.json without webhook secret
  await platform.fs.atomicWriteText(
    join(home, ".bento", "deploy.json"),
    `${
      JSON.stringify(
        {
          timeoutSec: app.deploy.timeoutSec,
          workdir: app.deploy.workdir,
          argv: app.deploy.argv,
          queuePolicy: app.deploy.queuePolicy,
        },
        null,
        2,
      )
    }\n`,
    0o640,
  );

  // queue.json
  const queuePath = join(home, ".bento", "queue.json");
  if (!(await platform.fs.exists(queuePath))) {
    await platform.fs.atomicWriteText(
      queuePath,
      `${JSON.stringify({ schemaVersion: 1, jobs: [] }, null, 2)}\n`,
      0o600,
    );
  }

  // Placeholder index
  const docRoot = join(home, "code", app.documentRoot || ".");
  await platform.fs.mkdirp(docRoot);
  const index = join(docRoot, "index.php");
  if (!(await platform.fs.exists(index))) {
    await platform.fs.atomicWriteText(
      index,
      `<?php\necho "bento app ${app.slug}\\n";\n`,
      0o644,
    );
  }

  if (recursivePerms) {
    // Initial recursive policy while the tree is still small (chown needs root/CAP_CHOWN).
    await applyAppPermissionPolicy(platform, app, { recursive: true });
  } else {
    await applyAppPermissionPolicy(platform, app, { recursive: false });
  }
}

export type AppDataPlaneResult = {
  mysqlApplied: boolean;
  redisApplied: boolean;
  /** Operator-facing note when best-effort work was deferred. */
  deferredNotes: string[];
};

/**
 * Apply live MySQL/Redis side effects for a provisioned app.
 *
 * Explicit database request (createDatabase / databases just added): fail hard if MySQL is down.
 * Without an explicit database: best-effort account setup may defer.
 */
export async function applyAppDataPlane(
  platform: Platform,
  app: AppState,
  opts: {
    /** When true, MySQL must be up and grants applied for each recorded database. */
    explicitDatabase: boolean;
  },
): Promise<AppDataPlaneResult> {
  const deferredNotes: string[] = [];
  let mysqlApplied = false;
  let redisApplied = false;

  if (opts.explicitDatabase) {
    const rootPassword = await requireMysqlRootPassword(platform);
    if (!(await isMysqlReachable(platform, app.mysqlService))) {
      throw serviceError(
        `MySQL service ${app.mysqlService} is unavailable; database was not recorded`,
        "Start the stack MySQL service, confirm MYSQL_ROOT_PASSWORD, then retry `bento app create --db` or `bento mysql db`.",
      );
    }
    const dbs = app.databases.length > 0 ? app.databases.map((d) => d.name) : [app.slug];
    for (const dbName of dbs) {
      await applyAppMysqlGrants(platform, app, dbName, rootPassword);
    }
    mysqlApplied = true;
  } else {
    const rootPassword = await loadMysqlRootPassword(platform);
    mysqlApplied = await tryBestEffortMysqlAccount(platform, app, rootPassword);
    if (!mysqlApplied) {
      deferredNotes.push(
        `MySQL account setup deferred for ${app.slug}; retry with 'bento mysql db ${app.slug} ${app.slug}' when MySQL is up`,
      );
    }
  }

  const redisShared = await loadRedisPassword(platform);
  redisApplied = await tryApplyAppRedisAcl(platform, app, redisShared);
  if (app.redis.mode === "acl" && !redisApplied) {
    deferredNotes.push(
      `Redis ACL apply deferred for ${app.slug}; re-apply when redis is up`,
    );
  }

  return { mysqlApplied, redisApplied, deferredNotes };
}

export function getAppOrThrow(state: DesiredState, slug: string): AppState {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  return app;
}

export type AppLifecycleResult = {
  state: DesiredState;
  app: AppState;
  reloadPlan: ReloadPlan;
};

function appLifecycleReloadPlan(app: AppState): ReloadPlan {
  return mergeReloadPlans(
    reloadPlanForPoolChange(app.phpService),
    reloadPlanForRunnerChange(`${app.phpService}-runner`),
  );
}

/** Disable or enable runtime config while retaining the app and all durable data. */
export function setAppEnabled(
  state: DesiredState,
  slug: string,
  enabled: boolean,
  now: string,
): AppLifecycleResult {
  const current = getAppOrThrow(state, slug);
  const app = { ...current, enabled, updatedAt: now };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: app },
      updatedAt: now,
    },
    app,
    reloadPlan: appLifecycleReloadPlan(current),
  };
}

/**
 * Remove an app from Bento's desired state after an exact typed confirmation.
 * Durable home and database data are intentionally left for operator-owned cleanup.
 */
export function deleteApp(
  state: DesiredState,
  slug: string,
  confirmation?: string,
  now: string = new Date().toISOString(),
): AppLifecycleResult {
  const app = getAppOrThrow(state, slug);
  const expected = `delete ${slug}`;
  if (confirmation !== expected) {
    throw safetyError(
      `refusing to remove app ${slug}: confirmation must be exactly '${expected}'`,
      `Retry with --confirm '${expected}'. Durable home and database data will be retained.`,
    );
  }
  const apps = { ...state.apps };
  delete apps[slug];
  const domains = { ...state.domains };
  for (const [domain, owner] of Object.entries(domains)) {
    if (owner.kind === "app" && owner.slug === slug) delete domains[domain];
  }
  return {
    state: {
      ...state,
      apps,
      domains,
      cronJobs: state.cronJobs.filter((job) => job.app !== slug),
      workers: state.workers.filter((worker) => worker.app !== slug),
      updatedAt: now,
    },
    app,
    reloadPlan: appLifecycleReloadPlan(app),
  };
}

export function capacityWarnings(state: DesiredState): string[] {
  const warnings: string[] = [];
  for (const v of state.phpVersions) {
    const apps = Object.values(state.apps).filter((a) => a.enabled && a.phpVersion === v.version);
    let sum = 0;
    for (const a of apps) {
      const p = FPM_PROFILES[a.fpmProfile] ?? FPM_PROFILES[DEFAULT_FPM_PROFILE]!;
      sum += p.maxChildren;
    }
    if (sum > v.processCap) {
      warnings.push(
        `PHP ${v.version} (${v.service}): sum of pool max_children=${sum} exceeds process cap ${v.processCap}`,
      );
    }
  }
  return warnings;
}

export type { FpmProfile, PhpVersion };
