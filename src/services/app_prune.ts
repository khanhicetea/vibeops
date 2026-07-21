/** Destructive cleanup for durable data retained after app removal. */

import { join } from "@std/path";
import type { AppState, DesiredState } from "../domain/state.ts";
import { conflictError, safetyError, serviceError, validationError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";
import { parseAppSlug, unwrap } from "../schemas/validators.ts";
import { execMysqlSql } from "./mysql.ts";
import { requireMysqlRootPassword } from "./stack_env.ts";
import { mysqlIdent } from "./template.ts";

const MANIFEST = ".bento/prune.json";

export type AppPruneManifest = {
  version: 1;
  slug: string;
  mysqlService: string;
  mysqlUser: string;
  databases: string[];
};

export type AppPrunePlan = AppPruneManifest & {
  home: string;
  manifestFound: boolean;
};

/** Save non-secret cleanup metadata in the retained home before state is removed. */
export async function writeAppPruneManifest(platform: Platform, app: AppState): Promise<void> {
  const home = platform.paths.appHome(app.slug);
  await platform.fs.mkdirp(join(home, ".bento"), 0o700);
  const manifest: AppPruneManifest = {
    version: 1,
    slug: app.slug,
    mysqlService: app.mysqlService,
    mysqlUser: app.mysqlUser,
    databases: app.databases.map((database) => database.name),
  };
  await platform.fs.writeText(
    join(home, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
}

/** Build the exact cleanup list. Active apps can never be pruned. */
export async function planAppPrune(
  platform: Platform,
  state: DesiredState,
  slugInput: string,
): Promise<AppPrunePlan> {
  const slug = unwrap(parseAppSlug(slugInput), "slug");
  if (state.apps[slug]) {
    throw conflictError(
      `refusing to prune active app ${slug}`,
      `Remove it first with bento app remove ${slug} --confirm 'delete ${slug}'.`,
    );
  }

  const home = platform.paths.appHome(slug);
  const manifestPath = join(home, MANIFEST);
  if (!(await platform.fs.exists(home))) {
    throw validationError(`no retained data found for app ${slug}`);
  }
  if (!(await platform.fs.exists(manifestPath))) {
    return {
      version: 1,
      slug,
      mysqlService: "",
      mysqlUser: "",
      databases: [],
      home,
      manifestFound: false,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await platform.fs.readText(manifestPath));
  } catch {
    throw validationError(`invalid app prune manifest: ${manifestPath}`);
  }
  const value = raw as Partial<AppPruneManifest>;
  const databases = Array.isArray(value.databases) ? value.databases : [];
  const valid = value.version === 1 && value.slug === slug &&
    typeof value.mysqlService === "string" && /^[a-zA-Z0-9_-]+$/.test(value.mysqlService) &&
    typeof value.mysqlUser === "string" && value.mysqlUser === slug &&
    databases.every((name) =>
      typeof name === "string" && /^[a-zA-Z0-9_]+$/.test(name) &&
      (name === slug || name.startsWith(`${slug}_`))
    ) && state.mysqlVersions.some((mysql) => mysql.service === value.mysqlService);
  if (!valid) throw validationError(`unsafe app prune manifest: ${manifestPath}`);

  return {
    version: 1,
    slug,
    mysqlService: value.mysqlService!,
    mysqlUser: value.mysqlUser!,
    databases: databases as string[],
    home,
    manifestFound: true,
  };
}

export type AppPruneResult = { cleaned: string[] };

/** Execute a pre-listed plan only after the literal confirmation `delete`. */
export async function executeAppPrune(
  platform: Platform,
  plan: AppPrunePlan,
  confirmation: string | null,
): Promise<AppPruneResult> {
  if (confirmation !== "delete") {
    throw safetyError(
      `refusing to prune app ${plan.slug}: confirmation must be exactly 'delete'`,
      "Run the command again and type delete at the prompt.",
    );
  }

  const cleaned: string[] = [];
  if (plan.manifestFound) {
    const password = await requireMysqlRootPassword(platform);
    const sql = [
      ...plan.databases.map((database) => `DROP DATABASE IF EXISTS ${mysqlIdent(database)};`),
      `DROP USER IF EXISTS ${mysqlIdent(plan.mysqlUser)}@'%';`,
      "FLUSH PRIVILEGES;",
    ].join("\n");
    const result = await execMysqlSql(platform, plan.mysqlService, sql, password);
    if (result.code !== 0) {
      throw serviceError(
        `failed to prune MySQL data for ${plan.slug}: ${
          result.stderr.trim() || `exit ${result.code}`
        }`,
        "Start the recorded MySQL service and retry; the retained home was not removed.",
      );
    }
    for (const database of plan.databases) cleaned.push(`database ${database}`);
    cleaned.push(`MySQL account ${plan.mysqlUser}@%`);
  }

  await platform.fs.remove(plan.home, { recursive: true });
  cleaned.push(`home ${plan.home}`);
  return { cleaned };
}
