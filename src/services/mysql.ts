/**
 * MySQL version management, app grants, backup/restore planning.
 * Passwords never appear in host process arguments.
 */

import { basename, join } from "@std/path";
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

/** SQL to ensure app user and grants for a specific database. */
export function grantSql(app: AppState, dbName: string, password: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const db = mysqlIdent(dbName);
  const like = mysqlLikeEscape(app.slug);
  const pw = mysqlStringLiteral(password);
  return [
    `CREATE DATABASE IF NOT EXISTS ${db};`,
    `CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${pw};`,
    `ALTER USER ${user}@'%' IDENTIFIED BY ${pw};`,
    `GRANT ALL PRIVILEGES ON ${db}.* TO ${user}@'%';`,
    `GRANT ALL PRIVILEGES ON \`${like}\\_%\`.* TO ${user}@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
}

/** Best-effort account setup without recording a database. */
export function accountSetupSql(app: AppState, password: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const slugDb = mysqlIdent(app.slug);
  const like = mysqlLikeEscape(app.slug);
  const pw = mysqlStringLiteral(password);
  return [
    `CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ${pw};`,
    `ALTER USER ${user}@'%' IDENTIFIED BY ${pw};`,
    `GRANT ALL PRIVILEGES ON ${slugDb}.* TO ${user}@'%';`,
    `GRANT ALL PRIVILEGES ON \`${like}\\_%\`.* TO ${user}@'%';`,
    `FLUSH PRIVILEGES;`,
  ].join("\n");
}

/** SQL to rotate app user password only. */
export function rotatePasswordSql(app: AppState, password: string): string {
  const user = mysqlIdent(app.mysqlUser);
  const pw = mysqlStringLiteral(password);
  return [
    `ALTER USER ${user}@'%' IDENTIFIED BY ${pw};`,
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
      // Stream dump through stdin-staged option file so password is not on argv.
      const script = [
        "set -e",
        "umask 077",
        "OPT=$(mktemp)",
        "trap 'rm -f \"$OPT\"' EXIT",
        "while IFS= read -r line; do",
        '  case "$line" in',
        "    __END_CNF__) break ;;",
        '    *) printf \'%s\\n\' "$line" >> "$OPT" ;;',
        "  esac",
        "done",
        `mysqldump --defaults-extra-file="$OPT" --single-transaction --routines --triggers --databases ${
          shellQuote(t.database)
        }${compress === "gzip" ? " | gzip -c" : compress === "zstd" ? " | zstd -c" : ""}`,
      ].join("\n");

      const stdin = [
        "[client]",
        "user=root",
        `password=${rootPassword.replace(/\n/g, "")}`,
        "__END_CNF__",
        "",
      ].join("\n");

      const result = await platform.process.run(
        ["docker", "compose", "exec", "-T", t.service, "sh", "-c", script],
        {
          cwd: platform.paths.paths.root,
          stdin,
          timeoutMs: 30 * 60_000,
        },
      );

      void dumpCmd;
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

  // Stream file into container mysql via stdin-staged option file
  const bytes = await platform.fs.readBytes(file);
  const script = [
    "set -e",
    "umask 077",
    "OPT=$(mktemp)",
    "DATA=$(mktemp)",
    'trap \'rm -f "$OPT" "$DATA"\' EXIT',
    "while IFS= read -r line; do",
    '  case "$line" in',
    "    __END_CNF__) break ;;",
    '    *) printf \'%s\\n\' "$line" >> "$OPT" ;;',
    "  esac",
    "done",
    'cat > "$DATA"',
    `${decompress} < "$DATA" | mysql --defaults-extra-file="$OPT" ${shellQuote(dbName)}`,
  ].join("\n");

  const cnf = [
    "[client]",
    "user=root",
    `password=${rootPassword.replace(/\n/g, "")}`,
    "__END_CNF__",
    "",
  ].join("\n");
  const stdin = new Uint8Array([
    ...new TextEncoder().encode(cnf),
    ...bytes,
  ]);

  const result = await platform.process.run(
    ["docker", "compose", "exec", "-T", app.mysqlService, "sh", "-c", script],
    {
      cwd: platform.paths.paths.root,
      stdin,
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

/** Apply a rotated password to a live MySQL service when reachable. */
export async function applyRotatedMysqlPassword(
  platform: Platform,
  app: AppState,
  rootPassword: string | undefined,
): Promise<boolean> {
  if (!rootPassword) return false;
  if (!(await isMysqlReachable(platform, app.mysqlService))) return false;
  const result = await execMysqlSql(
    platform,
    app.mysqlService,
    rotatePasswordSql(app, app.mysqlPassword),
    rootPassword,
  );
  return result.code === 0;
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
  | { kind: "root"; service: string; password: string }
  | { kind: "app"; app: AppState };

export type MysqlShellPlan = {
  service: string;
  user: string;
  database?: string;
  /** Stage protected option file via stdin (password never on host argv). */
  stage: { command: string[]; stdin: string };
  /** Open mysql using the staged option file. */
  open: { command: string[]; interactive: boolean };
  /** Always remove the staged option file. */
  cleanup: { command: string[] };
  optionPath: string;
};

/**
 * Plan a MySQL client session that stages a restricted option file in-container.
 * Password is only present on stage stdin — never host argv.
 */
export function buildMysqlShellPlan(
  platform: Platform,
  identity: MysqlShellIdentity,
  opts?: { database?: string; interactive?: boolean },
): MysqlShellPlan {
  const token = platform.random.hex(8);
  const optionPath = mysqlClientOptionPath(token);
  const interactive = opts?.interactive ?? true;

  let service: string;
  let user: string;
  let password: string;
  let database = opts?.database;

  if (identity.kind === "root") {
    service = identity.service;
    user = "root";
    password = identity.password;
  } else {
    service = identity.app.mysqlService;
    user = identity.app.mysqlUser;
    password = identity.app.mysqlPassword;
    if (!database && identity.app.databases[0]) {
      database = identity.app.databases[0].name;
    }
  }

  const cnf = [
    "[client]",
    `user=${user}`,
    `password=${password.replace(/\n/g, "")}`,
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
      command: [
        "docker",
        "compose",
        "exec",
        "-T",
        service,
        "rm",
        "-f",
        optionPath,
      ],
    },
  };
}

/** Assert no secret material appears in shell plan argv. */
export function assertShellPlanSecretsOffArgv(
  plan: MysqlShellPlan,
  secrets: string[],
): void {
  const argv = [
    ...plan.stage.command,
    ...plan.open.command,
    ...plan.cleanup.command,
  ].join(" ");
  for (const secret of secrets) {
    if (secret && argv.includes(secret)) {
      throw serviceError("mysql shell plan leaked a secret onto host argv");
    }
  }
}

/** SQL to report managed database sizes (no secrets). */
export function databaseSizeSql(databases: string[]): string {
  if (databases.length === 0) {
    return [
      "SELECT table_schema AS db_name,",
      "  ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb,",
      "  COUNT(*) AS tables",
      "FROM information_schema.tables",
      "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')",
      "GROUP BY table_schema",
      "ORDER BY size_mb DESC;",
    ].join("\n");
  }
  const list = databases.map((d) => mysqlStringLiteral(d)).join(", ");
  return [
    "SELECT table_schema AS db_name,",
    "  ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb,",
    "  COUNT(*) AS tables",
    "FROM information_schema.tables",
    `WHERE table_schema IN (${list})`,
    "GROUP BY table_schema",
    "ORDER BY size_mb DESC;",
  ].join("\n");
}

/** SQL for SHOW FULL PROCESSLIST (operator-safe; no credentials). */
export function processlistSql(): string {
  return "SHOW FULL PROCESSLIST;";
}

export type MysqlSizeRow = {
  database: string;
  sizeMb: string;
  tables: string;
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
  // TSV header-less for easy parsing
  const wrapped = [
    "SELECT table_schema,",
    "  IFNULL(ROUND(SUM(data_length + index_length) / 1024 / 1024, 2), 0),",
    "  COUNT(*)",
    "FROM information_schema.tables",
    databases.length
      ? `WHERE table_schema IN (${databases.map((d) => mysqlStringLiteral(d)).join(", ")})`
      : "WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')",
    "GROUP BY table_schema",
    "ORDER BY 2 DESC;",
  ].join("\n");
  void sql;
  const result = await execMysqlSql(platform, service, wrapped, rootPassword);
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
    if (parts.length < 3) continue;
    rows.push({
      database: parts[0] ?? "",
      sizeMb: parts[1] ?? "0",
      tables: parts[2] ?? "0",
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
void basename;
void asMysqlService;
