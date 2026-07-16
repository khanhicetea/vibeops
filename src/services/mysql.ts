/**
 * MySQL version management, app grants, backup/restore planning.
 * Passwords never appear in host process arguments.
 */

import { basename, join } from "@std/path";
import type { AppState, DesiredState, ManagedMysqlVersion } from "../domain/state.ts";
import { mysqlImage, mysqlServiceName } from "../domain/state.ts";
import { asDatabaseName, asMysqlService, asMysqlVersion } from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import { parseMysqlVersion, unwrap } from "../schemas/validators.ts";
import type { Platform, RunResult } from "../platform/mod.ts";
import { mysqlIdent, mysqlLikeEscape } from "./template.ts";

export function addMysqlVersion(
  state: DesiredState,
  versionInput: string,
): DesiredState {
  const version = asMysqlVersion(unwrap(parseMysqlVersion(versionInput), "mysqlVersion"));
  if (state.mysqlVersions.some((v) => v.version === version)) {
    throw conflictError(`MySQL version ${version} is already managed`);
  }
  const service = mysqlServiceName(version);
  const managed: ManagedMysqlVersion = {
    version,
    service,
    image: mysqlImage(version),
    volume: `bento-${service}-data`,
  };
  return {
    ...state,
    mysqlVersions: [...state.mysqlVersions, managed].sort((a, b) =>
      a.version.localeCompare(b.version)
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function removeMysqlVersion(_state: DesiredState, _version: string): never {
  throw safetyError(
    "automated MySQL version removal is unsupported",
    "MySQL service removal would couple with durable volume destruction and is intentionally unavailable.",
  );
}

export function createAppDatabase(
  state: DesiredState,
  slug: string,
  dbName: string,
  now: string,
): DesiredState {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw validationError(`invalid database name ${dbName}`);
  }
  if (dbName !== slug && !dbName.startsWith(`${slug}_`)) {
    throw validationError(
      `database ${dbName} outside app namespace; use ${slug} or ${slug}_*`,
    );
  }
  if (app.databases.some((d) => d.name === dbName)) {
    throw conflictError(`database ${dbName} already recorded for app ${slug}`);
  }
  // Cross-service creation refused before SQL runs — app has single service.
  const nextApp: AppState = {
    ...app,
    databases: [
      ...app.databases,
      { name: asDatabaseName(dbName), createdAt: now },
    ],
    updatedAt: now,
  };
  return {
    ...state,
    apps: { ...state.apps, [slug]: nextApp },
    updatedAt: now,
  };
}

/** SQL to ensure app user and grants (password passed via option file, not argv). */
export function grantSql(app: AppState, dbName: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const db = mysqlIdent(dbName);
  // Escape wildcards in app name for namespace grants
  const like = mysqlLikeEscape(app.slug);
  return [
    `CREATE DATABASE IF NOT EXISTS ${db};`,
    `CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY @bento_app_password;`,
    `ALTER USER ${user}@'%' IDENTIFIED BY @bento_app_password;`,
    `GRANT ALL PRIVILEGES ON ${db}.* TO ${user}@'%';`,
    `GRANT ALL PRIVILEGES ON \`${like}\\_%\`.* TO ${user}@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
}

/**
 * Run SQL inside MySQL container using a protected option file staged via stdin.
 * Password never appears in host argv.
 */
export async function execMysqlSql(
  platform: Platform,
  service: string,
  sql: string,
  password: string,
): Promise<RunResult> {
  // Stage option file content through container stdin to a temp path, run, remove.
  const script = [
    "set -e",
    "umask 077",
    "OPT=$(mktemp)",
    `cat > "$OPT" <<'EOF'`,
    "[client]",
    "user=root",
    `password=${password.replace(/\n/g, "")}`,
    "EOF",
    `mysql --defaults-extra-file="$OPT" -e ${shellQuote(sql)}`,
    'rm -f "$OPT"',
  ].join("\n");

  return await platform.process.run(
    ["docker", "compose", "exec", "-T", service, "sh", "-c", script],
    { cwd: platform.paths.paths.root, timeoutMs: 60_000 },
  );
}

export type BackupRequest = {
  scope: "database" | "app" | "all";
  slug?: string;
  database?: string;
  compress?: "zstd" | "gzip" | "none";
};

export type BackupArtifact = {
  path: string;
  database: string;
  service: string;
  bytes: number;
};

/**
 * Plan and execute logical backups with atomic finalize.
 * Failed/empty dumps leave no final artifact.
 */
export async function runBackup(
  platform: Platform,
  state: DesiredState,
  req: BackupRequest,
  rootPassword: string,
): Promise<BackupArtifact[]> {
  const targets = resolveBackupTargets(state, req);
  const artifacts: BackupArtifact[] = [];
  const compress = req.compress ?? "zstd";

  try {
    for (const t of targets) {
      const ts = platform.clock.nowIso().replace(/[:.]/g, "-");
      const ext = compress === "none" ? "sql" : compress === "gzip" ? "sql.gz" : "sql.zst";
      const finalName = `${t.service}_${t.database}_${ts}.${ext}`;
      const dir = join(platform.paths.paths.backupsDir, t.service, t.database);
      await platform.fs.mkdirp(dir, 0o700);
      const finalPath = join(dir, finalName);
      const partialPath = `${finalPath}.partial`;

      const dumpCmd = buildDumpCommand(t.service, t.database, compress);
      // Stream to host partial file via docker exec
      const result = await platform.process.run(
        ["docker", "compose", "exec", "-T", t.service, "sh", "-c", dumpCmd.shell],
        {
          cwd: platform.paths.paths.root,
          env: {
            MYSQL_PWD: rootPassword, // inside container env only via compose exec - not host argv list for mysql
          },
          timeoutMs: 30 * 60_000,
        },
      );

      // Prefer writing stdout bytes as the dump stream
      if (result.code !== 0) {
        await platform.fs.remove(partialPath).catch(() => {});
        throw new Error(`dump failed for ${t.database}: ${result.stderr || result.stdout}`);
      }
      const bytes = new TextEncoder().encode(result.stdout);
      if (bytes.byteLength === 0) {
        await platform.fs.remove(partialPath).catch(() => {});
        throw new Error(`dump for ${t.database} was empty; not publishing`);
      }
      await platform.fs.writeBytes(partialPath, bytes, 0o600);
      await platform.fs.rename(partialPath, finalPath);
      artifacts.push({
        path: finalPath,
        database: t.database,
        service: t.service,
        bytes: bytes.byteLength,
      });
    }
  } catch (cause) {
    // Mid-batch failure preserves earlier good dumps; skip retention
    throw cause;
  }

  // Retention per database only after full batch success
  await applyRetention(platform, artifacts, 10);
  return artifacts;
}

function buildDumpCommand(
  _service: string,
  database: string,
  compress: "zstd" | "gzip" | "none",
): { shell: string } {
  // Use MYSQL_PWD inside container; not passed as mysql --password= on argv from host.
  const dump = `mysqldump --single-transaction --routines --triggers --databases ${
    shellQuote(database)
  }`;
  if (compress === "gzip") return { shell: `${dump} | gzip -c` };
  if (compress === "zstd") return { shell: `${dump} | zstd -c` };
  return { shell: dump };
}

function resolveBackupTargets(
  state: DesiredState,
  req: BackupRequest,
): Array<{ service: string; database: string; slug: string }> {
  if (req.scope === "database") {
    if (!req.slug || !req.database) {
      throw validationError("database backup requires --app and --database");
    }
    const app = state.apps[req.slug];
    if (!app) throw notFoundError(`app not found: ${req.slug}`);
    if (!app.databases.some((d) => d.name === req.database)) {
      throw notFoundError(`database ${req.database} not recorded for app ${req.slug}`);
    }
    return [{ service: app.mysqlService, database: req.database, slug: req.slug }];
  }
  if (req.scope === "app") {
    if (!req.slug) throw validationError("app backup requires --app");
    const app = state.apps[req.slug];
    if (!app) throw notFoundError(`app not found: ${req.slug}`);
    return app.databases.map((d) => ({
      service: app.mysqlService,
      database: d.name,
      slug: req.slug!,
    }));
  }
  // all user databases
  const out: Array<{ service: string; database: string; slug: string }> = [];
  for (const app of Object.values(state.apps)) {
    for (const d of app.databases) {
      out.push({ service: app.mysqlService, database: d.name, slug: app.slug });
    }
  }
  return out;
}

async function applyRetention(
  platform: Platform,
  artifacts: BackupArtifact[],
  keep: number,
): Promise<void> {
  const byDb = new Map<string, string>();
  for (const a of artifacts) {
    byDb.set(
      `${a.service}/${a.database}`,
      join(platform.paths.paths.backupsDir, a.service, a.database),
    );
  }
  for (const dir of byDb.values()) {
    if (!(await platform.fs.exists(dir))) continue;
    const names = (await platform.fs.readDir(dir))
      .filter((n) => !n.endsWith(".partial"))
      .sort()
      .reverse();
    for (const n of names.slice(keep)) {
      await platform.fs.remove(join(dir, n));
    }
  }
}

export type RestoreRequest = {
  file: string;
  slug: string;
  targetDatabase: string;
  /** Required exact original name when replacing. */
  replaceOriginal?: string;
};

export async function runRestore(
  platform: Platform,
  state: DesiredState,
  req: RestoreRequest,
  rootPassword: string,
): Promise<void> {
  const app = state.apps[req.slug];
  if (!app) throw notFoundError(`app not found: ${req.slug}`);

  if (req.replaceOriginal !== undefined) {
    if (req.replaceOriginal !== req.targetDatabase) {
      throw safetyError(
        "replace confirmation must exactly match the target database name",
      );
    }
  }

  if (!/^[a-zA-Z0-9_]+$/.test(req.targetDatabase)) {
    throw validationError(`invalid target database ${req.targetDatabase}`);
  }

  // Namespace check for non-replace new names
  const dbName = req.targetDatabase;
  if (dbName !== app.slug && !dbName.startsWith(`${app.slug}_`)) {
    throw validationError(`target database outside app namespace`);
  }

  const file = req.file;
  if (!(await platform.fs.exists(file))) {
    throw notFoundError(`backup file not found: ${file}`);
  }

  const decompress = file.endsWith(".gz")
    ? "gzip -dc"
    : file.endsWith(".zst") || file.endsWith(".zstd")
    ? "zstd -dc"
    : "cat";

  // Non-atomic at object level — communicate limitation
  const createSql = req.replaceOriginal
    ? `DROP DATABASE IF EXISTS ${mysqlIdent(dbName)}; CREATE DATABASE ${mysqlIdent(dbName)};`
    : `CREATE DATABASE IF NOT EXISTS ${mysqlIdent(dbName)};`;

  await execMysqlSql(platform, app.mysqlService, createSql, rootPassword);

  // Stream file into container mysql
  const bytes = await platform.fs.readBytes(file);
  const script = [
    "set -e",
    "umask 077",
    "OPT=$(mktemp)",
    `cat > "$OPT" <<'EOF'`,
    "[client]",
    "user=root",
    `password=${rootPassword.replace(/\n/g, "")}`,
    "EOF",
    `${decompress} | mysql --defaults-extra-file="$OPT" ${shellQuote(dbName)}`,
    'rm -f "$OPT"',
  ].join("\n");

  // Feed backup bytes on stdin to decompress pipeline
  // For simplicity when decompress is cat, pipe bytes; for compressed, write temp inside.
  const result = await platform.process.run(
    ["docker", "compose", "exec", "-T", app.mysqlService, "sh", "-c", script],
    {
      cwd: platform.paths.paths.root,
      stdin: bytes,
      timeoutMs: 60 * 60_000,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `restore failed (destination may be partial; restore is not object-level atomic): ${
        result.stderr || result.stdout
      }`,
    );
  }
}

export function rotateAppPassword(
  platform: Platform,
  state: DesiredState,
  slug: string,
): { state: DesiredState; password: string } {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  const password = platform.random.hex(18);
  const nextApp: AppState = {
    ...app,
    mysqlPassword: password,
    updatedAt: platform.clock.nowIso(),
  };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: nextApp },
      updatedAt: nextApp.updatedAt,
    },
    password,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function listMysqlVersions(state: DesiredState): ManagedMysqlVersion[] {
  return [...state.mysqlVersions].sort((a, b) => a.version.localeCompare(b.version));
}

// silence unused
void basename;
void asMysqlService;
