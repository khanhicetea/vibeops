/**
 * MySQL version management, app grants, backup/restore planning.
 * Passwords never appear in host process arguments.
 */

import { basename, isAbsolute, join, relative, resolve } from "@std/path";
import type { AppState, DesiredState, ManagedMysqlVersion } from "../domain/state.ts";
import { mysqlImage, mysqlServiceName } from "../domain/state.ts";
import { asDatabaseName, asMysqlService, asMysqlVersion } from "../domain/types.ts";
import {
  conflictError,
  notFoundError,
  safetyError,
  serviceError,
  validationError,
} from "../domain/errors.ts";
import { compareMajorMinor, parseMysqlVersion, unwrap } from "../schemas/validators.ts";
import type { Platform, RunResult } from "../platform/mod.ts";
import { mysqlIdent, mysqlLikeEscape, mysqlStringLiteral } from "./template.ts";

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
    volume: `${service}-data`,
  };
  return {
    ...state,
    mysqlVersions: [...state.mysqlVersions, managed].sort((a, b) =>
      compareMajorMinor(a.version, b.version)
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

/** SQL to ensure app user and grants without changing an existing user's password. */
export function grantSql(app: AppState, dbName: string, password: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const db = mysqlIdent(dbName);
  const like = mysqlLikeEscape(app.slug);
  const pw = mysqlStringLiteral(password);
  return [
    `CREATE DATABASE IF NOT EXISTS ${db};`,
    `CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${pw};`,
    `GRANT ALL PRIVILEGES ON ${db}.* TO ${user}@'%';`,
    `GRANT ALL PRIVILEGES ON \`${like}\\_%\`.* TO ${user}@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
}

/** Best-effort account setup without recording a database or resetting its password. */
export function accountSetupSql(app: AppState, password: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const slugDb = mysqlIdent(app.slug);
  const like = mysqlLikeEscape(app.slug);
  const pw = mysqlStringLiteral(password);
  return [
    `CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${pw};`,
    `GRANT ALL PRIVILEGES ON ${slugDb}.* TO ${user}@'%';`,
    `GRANT ALL PRIVILEGES ON \`${like}\\_%\`.* TO ${user}@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
}

/**
 * Run SQL inside MySQL container using a protected option file staged via stdin.
 * Password never appears in host argv (only on the process stdin stream).
 */
export async function execMysqlSql(
  platform: Platform,
  service: string,
  sql: string,
  password: string,
): Promise<RunResult> {
  // Script reads option-file lines until __END_CNF__, then remaining stdin as SQL.
  // The password is only present in stdin, never interpolated into argv.
  const script = [
    "set -e",
    "umask 077",
    "OPT=$(mktemp)",
    "SQL=$(mktemp)",
    'trap \'rm -f "$OPT" "$SQL"\' EXIT',
    "while IFS= read -r line; do",
    '  case "$line" in',
    "    __END_CNF__) break ;;",
    '    *) printf \'%s\\n\' "$line" >> "$OPT" ;;',
    "  esac",
    "done",
    'cat > "$SQL"',
    'mysql --defaults-extra-file="$OPT" < "$SQL"',
  ].join("\n");

  const stdin = [
    "[client]",
    "user=root",
    `password=${password.replace(/\n/g, "")}`,
    "__END_CNF__",
    sql,
    "",
  ].join("\n");

  return await platform.process.run(
    ["docker", "compose", "exec", "-T", service, "sh", "-c", script],
    { cwd: platform.paths.paths.root, stdin, timeoutMs: 60_000 },
  );
}

/** True when the MySQL service container accepts compose exec. */
export async function isMysqlReachable(
  platform: Platform,
  service: string,
): Promise<boolean> {
  try {
    const result = await platform.process.run(
      ["docker", "compose", "exec", "-T", service, "true"],
      { cwd: platform.paths.paths.root, timeoutMs: 8_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Apply CREATE DATABASE + grants for an app database.
 * Throws SERVICE error on failure.
 */
export async function applyAppMysqlGrants(
  platform: Platform,
  app: AppState,
  dbName: string,
  rootPassword: string,
): Promise<void> {
  const sql = grantSql(app, dbName, app.mysqlPassword);
  const result = await execMysqlSql(platform, app.mysqlService, sql, rootPassword);
  if (result.code !== 0) {
    throw serviceError(
      `MySQL grant failed for database ${dbName} on ${app.mysqlService}: ${
        (result.stderr || result.stdout || "unknown error").trim()
      }`,
      "Ensure the MySQL service is running and MYSQL_ROOT_PASSWORD matches the container, then retry `bento mysql db`.",
    );
  }
}

/**
 * Best-effort MySQL account setup when the operator did not request a database.
 * Returns true when applied, false when deferred (unreachable / failed).
 */
export async function tryBestEffortMysqlAccount(
  platform: Platform,
  app: AppState,
  rootPassword: string | undefined,
): Promise<boolean> {
  if (!rootPassword) return false;
  if (!(await isMysqlReachable(platform, app.mysqlService))) return false;
  const sql = accountSetupSql(app, app.mysqlPassword);
  const result = await execMysqlSql(platform, app.mysqlService, sql, rootPassword);
  return result.code === 0;
}

/**
 * Explicit database request path: require MySQL, apply grants, then return
 * state with the database recorded. Fails before recording if MySQL is down.
 */
export async function createAppDatabaseLive(
  platform: Platform,
  state: DesiredState,
  slug: string,
  dbName: string,
  rootPassword: string,
): Promise<DesiredState> {
  // Validate namespace / uniqueness first (pure).
  const validated = createAppDatabase(
    state,
    slug,
    dbName,
    platform.clock.nowIso(),
  );
  const app = validated.apps[slug]!;
  if (!(await isMysqlReachable(platform, app.mysqlService))) {
    throw serviceError(
      `MySQL service ${app.mysqlService} is unavailable; database ${dbName} was not recorded`,
      "Start the stack MySQL service (e.g. `bento compose -- up -d`), confirm MYSQL_ROOT_PASSWORD, then retry `bento mysql db` or `bento app create --db`.",
    );
  }
  await applyAppMysqlGrants(platform, app, dbName, rootPassword);
  return validated;
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

export type RecentBackupFile = {
  path: string;
  bytes: number;
  /** Filesystem finalization time used as the backup creation date. */
  createdAt: Date | null;
};

/**
 * Find finalized logical dumps below the stack backup directory, newest first.
 * Symlinks, partial dumps, restore staging files, and unrelated state backups
 * are excluded.
 */
export async function listRecentBackupFiles(
  platform: Platform,
  limit = 20,
): Promise<RecentBackupFile[]> {
  const root = platform.paths.paths.backupsDir;
  if (!(await platform.fs.exists(root))) return [];

  const files: RecentBackupFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    // Bento backup paths are root/service/database/file. Keep malformed trees
    // bounded while still allowing a little room for operator organization.
    if (depth > 8) return;
    for (const name of await platform.fs.readDir(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      const entry = await platform.fs.lstat(path).catch(() => null);
      // A concurrent retention pass may remove a file while it is listed.
      if (!entry) continue;
      if (entry.isSymlink) continue;
      if (entry.isDirectory) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile || entry.size === 0 || !/\.sql(?:\.gz|\.zst|\.zstd)?$/i.test(name)) {
        continue;
      }
      const stat = await platform.fs.stat(path).catch(() => null);
      if (!stat?.isFile || stat.size === 0) continue;
      files.push({ path, bytes: stat.size, createdAt: stat.modifiedAt });
    }
  };

  await walk(root, 0);
  return files
    .sort((a, b) => {
      const newest = (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
      return newest || a.path.localeCompare(b.path);
    })
    .slice(0, Math.max(0, Math.floor(limit)));
}

/**
 * Plan and execute logical backups with atomic finalize.
 * Failed/empty dumps leave no final artifact.
 */
export async function runBackup(
  platform: Platform,
  state: DesiredState,
  req: BackupRequest,
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
      const containerFinal = `/var/backups/bento/${t.database}/${finalName}`;
      const containerPartial = `${containerFinal}.partial`;
      const dump = `mysqldump --defaults-extra-file=/etc/bento/mysql/root.cnf ` +
        `--single-transaction --routines --triggers ${shellQuote(t.database)}`;
      const pipeline = compress === "gzip"
        ? `${dump} | gzip -c`
        : compress === "zstd"
        ? `${dump} | zstd -3 -q -c`
        : dump;

      // The dump and compression run beside mysqld over its Unix socket. The
      // bind-mounted backup directory keeps dump bytes off the exec stream.
      const script = [
        "set -e",
        "set -o pipefail",
        "umask 077",
        "test -r /etc/bento/mysql/root.cnf || { echo 'missing generated MySQL root option file; run bento render' >&2; exit 1; }",
        "grep -q '^protocol=socket$' /etc/bento/mysql/root.cnf || { echo 'stale MySQL root option file; run bento render' >&2; exit 1; }",
        `test -d ${
          shellQuote(`/var/backups/bento/${t.database}`)
        } || { echo 'MySQL backup bind is not active; run bento render then bento compose -- up -d' >&2; exit 1; }`,
        `PARTIAL=${shellQuote(containerPartial)}`,
        `FINAL=${shellQuote(containerFinal)}`,
        "trap 'rm -f \"$PARTIAL\"' EXIT",
        `${pipeline} > "$PARTIAL"`,
        'test -s "$PARTIAL"',
        'chmod 600 "$PARTIAL"',
        'mv -f "$PARTIAL" "$FINAL"',
        "trap - EXIT",
      ].join("\n");

      const result = await platform.process.run(
        ["docker", "compose", "exec", "-T", t.service, "sh", "-c", script],
        {
          cwd: platform.paths.paths.root,
          timeoutMs: 30 * 60_000,
        },
      );

      if (result.code !== 0) {
        await platform.fs.remove(partialPath).catch(() => {});
        throw new Error(`dump failed for ${t.database}: ${result.stderr || result.stdout}`);
      }
      if (!(await platform.fs.exists(finalPath))) {
        throw new Error(`dump for ${t.database} was empty; not publishing`);
      }
      const stat = await platform.fs.stat(finalPath);
      if (!stat.isFile || stat.size === 0) {
        await platform.fs.remove(finalPath).catch(() => {});
        throw new Error(`dump for ${t.database} was empty; not publishing`);
      }
      artifacts.push({
        path: finalPath,
        database: t.database,
        service: t.service,
        bytes: stat.size,
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

  const sourceStat = await platform.fs.stat(file);
  if (!sourceStat.isFile || sourceStat.size === 0) {
    throw validationError(`backup file is empty or not a regular file: ${file}`);
  }

  const serviceBackupDir = join(platform.paths.paths.backupsDir, app.mysqlService);
  await platform.fs.mkdirp(serviceBackupDir, 0o700);
  let containerFile = pathInsideBackupMount(serviceBackupDir, file);
  let stagedFile: string | undefined;
  if (!containerFile) {
    const stageDir = join(serviceBackupDir, ".restore");
    await platform.fs.mkdirp(stageDir, 0o700);
    stagedFile = join(stageDir, `${platform.random.hex(8)}-${basename(file)}`);
    await platform.fs.copyFile(file, stagedFile);
    await platform.fs.chmod(stagedFile, 0o600);
    containerFile = `/var/backups/bento/.restore/${basename(stagedFile)}`;
  }

  const decompress = file.endsWith(".gz")
    ? `gzip -dc -- ${shellQuote(containerFile)}`
    : file.endsWith(".zst") || file.endsWith(".zstd")
    ? `zstd -dc -- ${shellQuote(containerFile)}`
    : `cat -- ${shellQuote(containerFile)}`;

  // Create and import in the matching MySQL container. Both clients use the
  // generated root option file and local mysqld Unix socket.
  const createSql = req.replaceOriginal
    ? `DROP DATABASE IF EXISTS ${mysqlIdent(dbName)}; CREATE DATABASE ${mysqlIdent(dbName)};`
    : `CREATE DATABASE IF NOT EXISTS ${mysqlIdent(dbName)};`;
  const script = [
    "set -e",
    "set -o pipefail",
    "test -r /etc/bento/mysql/root.cnf || { echo 'missing generated MySQL root option file; run bento render' >&2; exit 1; }",
    "grep -q '^protocol=socket$' /etc/bento/mysql/root.cnf || { echo 'stale MySQL root option file; run bento render' >&2; exit 1; }",
    `test -r ${
      shellQuote(containerFile)
    } || { echo 'MySQL backup bind is not active; run bento render then bento compose -- up -d' >&2; exit 1; }`,
    `mysql --defaults-extra-file=/etc/bento/mysql/root.cnf -e ${shellQuote(createSql)}`,
    `${decompress} | mysql --defaults-extra-file=/etc/bento/mysql/root.cnf ${shellQuote(dbName)}`,
  ].join("\n");

  try {
    const result = await platform.process.run(
      ["docker", "compose", "exec", "-T", app.mysqlService, "sh", "-c", script],
      {
        cwd: platform.paths.paths.root,
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
  } finally {
    if (stagedFile) await platform.fs.remove(stagedFile).catch(() => {});
  }
}

/** Map a host file already under a service backup bind to its container path. */
function pathInsideBackupMount(serviceBackupDir: string, file: string): string | undefined {
  const rel = relative(resolve(serviceBackupDir), resolve(file));
  if (
    !rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")
  ) {
    return undefined;
  }
  return `/var/backups/bento/${rel.replaceAll("\\", "/")}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function listMysqlVersions(state: DesiredState): ManagedMysqlVersion[] {
  return [...state.mysqlVersions].sort((a, b) => compareMajorMinor(a.version, b.version));
}

// ---------------------------------------------------------------------------
// Interactive shells, size, processlist (product §6.5)
// ---------------------------------------------------------------------------

/** In-container path for a staged client option file (0600, removed after use). */
export function mysqlClientOptionPath(token: string): string {
  return `/tmp/bento-mysql-${token}.cnf`;
}

export type MysqlShellIdentity =
  | { kind: "root"; service: string }
  | { kind: "app"; app: AppState };

export type MysqlShellPlan = {
  service: string;
  user: string;
  database?: string;
  /** App sessions stage a protected option file via stdin. */
  stage?: { command: string[]; stdin: string };
  /** Open mysql using the generated or staged option file. */
  open: { command: string[]; interactive: boolean };
  /** App sessions remove their temporary option file. */
  cleanup?: { command: string[] };
  optionPath: string;
};

/**
 * Root sessions use the generated, read-only socket option file. App sessions
 * stage their scoped credentials in-container and remove them afterward.
 */
export function buildMysqlShellPlan(
  platform: Platform,
  identity: MysqlShellIdentity,
  opts?: { database?: string; interactive?: boolean },
): MysqlShellPlan {
  const interactive = opts?.interactive ?? true;
  let database = opts?.database;

  if (identity.kind === "root") {
    const optionPath = "/etc/bento/mysql/root.cnf";
    const openArgs = [
      "mysql",
      `--defaults-extra-file=${optionPath}`,
      "--default-character-set=utf8mb4",
    ];
    if (database) openArgs.push(database);
    return {
      service: identity.service,
      user: "root",
      database,
      optionPath,
      open: {
        command: interactive
          ? ["docker", "compose", "exec", "-it", identity.service, ...openArgs]
          : ["docker", "compose", "exec", "-T", identity.service, ...openArgs],
        interactive,
      },
    };
  }

  const service = identity.app.mysqlService;
  const user = identity.app.mysqlUser;
  const password = identity.app.mysqlPassword;
  if (!database && identity.app.databases[0]) {
    database = identity.app.databases[0].name;
  }
  const optionPath = mysqlClientOptionPath(platform.random.hex(8));
  const cnf = [
    "[client]",
    `user=${user}`,
    `password=${password.replace(/\n/g, "")}`,
    "protocol=socket",
    "socket=/var/run/mysqld/mysqld.sock",
    "",
  ].join("\n");
  const stageScript = [
    "set -e",
    "umask 077",
    `cat > ${shellQuote(optionPath)}`,
    `chmod 600 ${shellQuote(optionPath)}`,
  ].join("\n");
  const openArgs = [
    "mysql",
    `--defaults-extra-file=${optionPath}`,
    "--default-character-set=utf8mb4",
  ];
  if (database) openArgs.push(database);

  return {
    service,
    user,
    database,
    optionPath,
    stage: {
      command: ["docker", "compose", "exec", "-T", service, "sh", "-c", stageScript],
      stdin: cnf,
    },
    open: {
      command: interactive
        ? ["docker", "compose", "exec", "-it", service, ...openArgs]
        : ["docker", "compose", "exec", "-T", service, ...openArgs],
      interactive,
    },
    cleanup: {
      command: ["docker", "compose", "exec", "-T", service, "rm", "-f", optionPath],
    },
  };
}

/** Assert no secret material appears in shell plan argv. */
export function assertShellPlanSecretsOffArgv(
  plan: MysqlShellPlan,
  secrets: string[],
): void {
  const argv = [
    ...(plan.stage?.command ?? []),
    ...plan.open.command,
    ...(plan.cleanup?.command ?? []),
  ].join(" ");
  for (const secret of secrets) {
    if (secret && argv.includes(secret)) {
      throw serviceError("mysql shell plan leaked a secret onto host argv");
    }
  }
}

/** SQL to report managed database sizes (no secrets). */
export function databaseSizeSql(databases: string[]): string {
  const where = databases.length
    ? `WHERE table_schema IN (${databases.map((d) => mysqlStringLiteral(d)).join(", ")})`
    : "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')";
  return [
    "SELECT table_schema AS db_name,",
    "  COUNT(*) AS tables,",
    "  IFNULL(ROUND(SUM(data_length) / 1024 / 1024, 2), 0) AS data_size,",
    "  IFNULL(ROUND(SUM(index_length) / 1024 / 1024, 2), 0) AS index_size,",
    "  IFNULL(ROUND(SUM(data_length + index_length) / 1024 / 1024, 2), 0) AS total_size",
    "FROM information_schema.tables",
    where,
    "GROUP BY table_schema",
    "ORDER BY total_size DESC;",
  ].join("\n");
}

/** SQL for SHOW FULL PROCESSLIST (operator-safe; no credentials). */
export function processlistSql(): string {
  return "SHOW FULL PROCESSLIST;";
}

export type MysqlSizeRow = {
  database: string;
  tables: string;
  dataSize: string;
  indexSize: string;
  totalSize: string;
};

/**
 * Query database sizes through a protected root option file (password on stdin only).
 */
export async function queryDatabaseSizes(
  platform: Platform,
  service: string,
  rootPassword: string,
  databases: string[] = [],
): Promise<{ stdout: string; rows: MysqlSizeRow[] }> {
  const sql = databaseSizeSql(databases);
  const result = await execMysqlSql(platform, service, sql, rootPassword);
  if (result.code !== 0) {
    throw serviceError(
      `MySQL size query failed on ${service}: ${
        (result.stderr || result.stdout || "unknown").trim()
      }`,
      "Ensure the MySQL service is running and MYSQL_ROOT_PASSWORD matches the container.",
    );
  }
  const rows: MysqlSizeRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 5) continue;
    // mysql prints column headings by default; they are metadata, not a database row.
    if (
      parts[0] === "db_name" && parts[1] === "tables" && parts[2] === "data_size" &&
      parts[3] === "index_size" && parts[4] === "total_size"
    ) continue;
    rows.push({
      database: parts[0] ?? "",
      tables: parts[1] ?? "0",
      dataSize: parts[2] ?? "0",
      indexSize: parts[3] ?? "0",
      totalSize: parts[4] ?? "0",
    });
  }
  return { stdout: result.stdout, rows };
}

/**
 * Query processlist through a protected root option file (password on stdin only).
 */
export async function queryProcesslist(
  platform: Platform,
  service: string,
  rootPassword: string,
): Promise<{ stdout: string }> {
  const result = await execMysqlSql(platform, service, processlistSql(), rootPassword);
  if (result.code !== 0) {
    throw serviceError(
      `MySQL processlist failed on ${service}: ${
        (result.stderr || result.stdout || "unknown").trim()
      }`,
      "Ensure the MySQL service is running and MYSQL_ROOT_PASSWORD matches the container.",
    );
  }
  return { stdout: result.stdout };
}

/** Resolve which MySQL service(s) an operator request targets. */
export function resolveMysqlServices(
  state: DesiredState,
  opts?: { service?: string; app?: string },
): string[] {
  if (opts?.service) {
    const found = state.mysqlVersions.find(
      (v) => v.service === opts.service || v.version === opts.service,
    );
    if (!found) throw notFoundError(`MySQL service not found: ${opts.service}`);
    return [found.service];
  }
  if (opts?.app) {
    const app = state.apps[opts.app];
    if (!app) throw notFoundError(`app not found: ${opts.app}`);
    return [app.mysqlService];
  }
  return state.mysqlVersions.map((v) => v.service);
}

// silence unused
void asMysqlService;
