/**
 * Runtime schema for desired state JSON (Zod).
 * bytes -> JSON unknown -> version discriminator -> validation -> migration -> DesiredState
 */

import { z } from "zod";
import {
  type AppDatabase,
  type AppDeployConfig,
  type AppRedisIdentity,
  type AppState,
  createEmptyState,
  type CronJob,
  type DesiredState,
  type DomainOwner,
  type EntrypointMode,
  type ManagedMysqlVersion,
  type ManagedPhpVersion,
  type ProxySite,
  type QueuePolicy,
  type RedisMode,
  type StackDefaults,
  type TemplateProvenance,
  type TlsMode,
  type Worker,
} from "../domain/state.ts";
import {
  asAbsoluteAppPath,
  asAppSlug,
  asCronJobName,
  asDatabaseName,
  asDomainName,
  asFpmProfile,
  asGid,
  asMysqlService,
  asMysqlVersion,
  asPhpVersion,
  asProxySiteName,
  asUid,
  asWorkerName,
} from "../domain/types.ts";
import { STATE_SCHEMA_VERSION } from "../version.ts";
import { stateError, validationError } from "../domain/errors.ts";
import { migrateStateDocument } from "./migrations.ts";
import {
  absolutePathSchema,
  appSlugSchema,
  cronScheduleSchema,
  domainNameSchema,
  err,
  fpmProfileSchema,
  fromZod,
  isoDateSchema,
  mysqlVersionSchema,
  nonEmptyStringSchema,
  ok,
  type ParseResult,
  phpVersionSchema,
  positiveIntSchema,
  safeRelativePathSchema,
  stringArraySchema,
  uidGidSchema,
  unwrap,
} from "./validators.ts";

// --- Zod schemas for state fragments ---------------------------------------

const tlsModeSchema: z.ZodType<TlsMode> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self-ca") }),
  z.object({ kind: z.literal("shared") }),
  z.object({ kind: z.literal("acme") }),
  z.object({
    kind: z.literal("external"),
    certPath: nonEmptyStringSchema,
    keyPath: nonEmptyStringSchema,
  }),
]);

const templateProvenanceSchema: z.ZodType<TemplateProvenance> = z.union([
  z.object({ kind: z.literal("upstream") }),
  z.object({
    kind: z.literal("custom"),
    sourcePath: nonEmptyStringSchema,
    activatedAt: isoDateSchema,
    copiedFromVersion: nonEmptyStringSchema.optional(),
  }),
]);

const deploySchema = z.object({
  enabled: z.boolean(),
  queuePolicy: z.enum(["latest", "fifo"]).default("latest"),
  timeoutSec: positiveIntSchema.default(900),
  workdir: nonEmptyStringSchema,
  argv: stringArraySchema.min(1, "must not be empty"),
  hmacSecret: nonEmptyStringSchema.optional(),
});

const redisSchema = z.object({
  mode: z.enum(["shared", "acl"]),
  prefix: nonEmptyStringSchema,
  password: z.string().optional(),
  aclUsername: nonEmptyStringSchema.optional(),
  aclPassword: z.string().optional(),
});

const databaseSchema = z.object({
  name: nonEmptyStringSchema.regex(
    /^[a-zA-Z0-9_]+$/,
    "must be alphanumeric/underscore",
  ),
  createdAt: isoDateSchema,
});

const appSchema = z.object({
  slug: appSlugSchema,
  uid: uidGidSchema,
  gid: uidGidSchema,
  home: absolutePathSchema,
  mainDomain: domainNameSchema,
  aliases: z.array(domainNameSchema).default([]),
  documentRoot: safeRelativePathSchema.default(""),
  entrypointMode: z.enum(["front-controller", "legacy"]),
  phpVersion: phpVersionSchema,
  phpService: nonEmptyStringSchema,
  fpmProfile: fpmProfileSchema,
  tls: tlsModeSchema,
  accessLog: z.boolean().default(false),
  mysqlService: nonEmptyStringSchema,
  mysqlUser: nonEmptyStringSchema,
  mysqlPassword: z.string(),
  databases: z.array(databaseSchema).default([]),
  redis: redisSchema,
  deploy: deploySchema,
  vhostTemplate: templateProvenanceSchema.default({ kind: "upstream" }),
  poolTemplate: templateProvenanceSchema.default({ kind: "upstream" }),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

const proxySchema = z.object({
  name: appSlugSchema,
  mainDomain: domainNameSchema,
  aliases: z.array(domainNameSchema).default([]),
  upstreams: z.array(nonEmptyStringSchema).min(1, "must contain at least one upstream"),
  tls: tlsModeSchema,
  accessLog: z.boolean().default(false),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

const domainOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app"), slug: appSlugSchema }),
  z.object({ kind: z.literal("proxy"), name: appSlugSchema }),
]);

const cronJobSchema = z.object({
  name: nonEmptyStringSchema,
  app: appSlugSchema,
  schedule: cronScheduleSchema,
  timezone: nonEmptyStringSchema.default("UTC"),
  workdir: nonEmptyStringSchema,
  command: stringArraySchema.min(1, "must not be empty"),
  commandMode: z.enum(["argv", "shell"]).default("argv"),
  output: z.enum(["log", "null", "inherit"]).default("log"),
  enabled: z.boolean().default(true),
  timeoutSec: positiveIntSchema.optional(),
  lock: nonEmptyStringSchema.optional(),
});

const workerSchema = z.object({
  name: nonEmptyStringSchema,
  app: appSlugSchema,
  command: stringArraySchema.min(1, "must not be empty"),
  workdir: nonEmptyStringSchema,
  enabled: z.boolean().default(true),
  autorestart: z.boolean().default(true),
  stopsignal: nonEmptyStringSchema.default("TERM"),
  stopwaitsecs: positiveIntSchema.default(10),
});

const defaultsSchema = z.object({
  phpVersion: phpVersionSchema,
  mysqlVersion: mysqlVersionSchema,
  fpmProfile: fpmProfileSchema,
  redisMode: z.enum(["shared", "acl"]).default("shared"),
});

const managedPhpSchema = z.object({
  version: phpVersionSchema,
  service: nonEmptyStringSchema,
  image: nonEmptyStringSchema,
  processCap: positiveIntSchema.default(200),
});

const managedMysqlSchema = z.object({
  version: mysqlVersionSchema,
  service: nonEmptyStringSchema,
  image: nonEmptyStringSchema,
  volume: nonEmptyStringSchema,
});

const desiredStateRawSchema = z.object({
  schemaVersion: z.number().int(),
  defaults: defaultsSchema,
  phpVersions: z.array(managedPhpSchema).min(1, "must not be empty"),
  mysqlVersions: z.array(managedMysqlSchema).min(1, "must not be empty"),
  apps: z.record(z.string(), appSchema),
  proxies: z.record(z.string(), proxySchema),
  domains: z.record(z.string(), domainOwnerSchema),
  cronJobs: z.array(cronJobSchema),
  workers: z.array(workerSchema),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

// --- Brand mappers ---------------------------------------------------------

function brandDatabase(db: z.infer<typeof databaseSchema>): AppDatabase {
  return { name: asDatabaseName(db.name), createdAt: db.createdAt };
}

function brandDeploy(d: z.infer<typeof deploySchema>): AppDeployConfig {
  return {
    enabled: d.enabled,
    queuePolicy: d.queuePolicy as QueuePolicy,
    timeoutSec: d.timeoutSec,
    workdir: d.workdir,
    argv: d.argv,
    ...(d.hmacSecret ? { hmacSecret: d.hmacSecret } : {}),
  };
}

function brandRedis(r: z.infer<typeof redisSchema>): AppRedisIdentity {
  return {
    mode: r.mode as RedisMode,
    prefix: r.prefix,
    ...(r.password !== undefined ? { password: r.password } : {}),
    ...(r.aclUsername ? { aclUsername: r.aclUsername } : {}),
    ...(r.aclPassword !== undefined ? { aclPassword: r.aclPassword } : {}),
  };
}

function brandApp(app: z.infer<typeof appSchema>): AppState {
  return {
    slug: asAppSlug(app.slug),
    uid: asUid(app.uid),
    gid: asGid(app.gid),
    home: asAbsoluteAppPath(app.home),
    mainDomain: asDomainName(app.mainDomain),
    aliases: app.aliases.map(asDomainName),
    documentRoot: app.documentRoot,
    entrypointMode: app.entrypointMode as EntrypointMode,
    phpVersion: asPhpVersion(app.phpVersion),
    phpService: app.phpService,
    fpmProfile: asFpmProfile(app.fpmProfile),
    tls: app.tls,
    accessLog: app.accessLog,
    mysqlService: asMysqlService(app.mysqlService),
    mysqlUser: app.mysqlUser,
    mysqlPassword: app.mysqlPassword,
    databases: app.databases.map(brandDatabase),
    redis: brandRedis(app.redis),
    deploy: brandDeploy(app.deploy),
    vhostTemplate: app.vhostTemplate,
    poolTemplate: app.poolTemplate,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

function brandProxy(proxy: z.infer<typeof proxySchema>): ProxySite {
  return {
    name: asProxySiteName(proxy.name),
    mainDomain: asDomainName(proxy.mainDomain),
    aliases: proxy.aliases.map(asDomainName),
    upstreams: proxy.upstreams,
    tls: proxy.tls,
    accessLog: proxy.accessLog,
    createdAt: proxy.createdAt,
    updatedAt: proxy.updatedAt,
  };
}

function brandDomainOwner(owner: z.infer<typeof domainOwnerSchema>): DomainOwner {
  if (owner.kind === "app") {
    return { kind: "app", slug: asAppSlug(owner.slug) };
  }
  return { kind: "proxy", name: asProxySiteName(owner.name) };
}

function brandCron(job: z.infer<typeof cronJobSchema>): CronJob {
  return {
    name: asCronJobName(job.name),
    app: asAppSlug(job.app),
    schedule: job.schedule,
    timezone: job.timezone,
    workdir: job.workdir,
    command: job.command,
    commandMode: job.commandMode,
    output: job.output,
    enabled: job.enabled,
    ...(job.timeoutSec !== undefined ? { timeoutSec: job.timeoutSec } : {}),
    ...(job.lock ? { lock: job.lock } : {}),
  };
}

function brandWorker(w: z.infer<typeof workerSchema>): Worker {
  return {
    name: asWorkerName(w.name),
    app: asAppSlug(w.app),
    command: w.command,
    workdir: w.workdir,
    enabled: w.enabled,
    autorestart: w.autorestart,
    stopsignal: w.stopsignal,
    stopwaitsecs: w.stopwaitsecs,
  };
}

function brandDefaults(d: z.infer<typeof defaultsSchema>): StackDefaults {
  return {
    phpVersion: asPhpVersion(d.phpVersion),
    mysqlVersion: asMysqlVersion(d.mysqlVersion),
    fpmProfile: asFpmProfile(d.fpmProfile),
    redisMode: d.redisMode as RedisMode,
  };
}

function brandPhpVersion(v: z.infer<typeof managedPhpSchema>): ManagedPhpVersion {
  return {
    version: asPhpVersion(v.version),
    service: v.service,
    image: v.image,
    processCap: v.processCap,
  };
}

function brandMysqlVersion(
  v: z.infer<typeof managedMysqlSchema>,
): ManagedMysqlVersion {
  return {
    version: asMysqlVersion(v.version),
    service: asMysqlService(v.service),
    image: v.image,
    volume: v.volume,
  };
}

/** Parse unknown JSON into DesiredState for the current schema version. */
export function parseDesiredState(value: unknown): ParseResult<DesiredState> {
  // Fast structural check so we can gate schemaVersion before deep validation.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("state must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return err("schemaVersion must be an integer");
  }
  if (schemaVersion > STATE_SCHEMA_VERSION) {
    return err(
      `state schemaVersion ${schemaVersion} is newer than supported ${STATE_SCHEMA_VERSION}; upgrade Bento`,
    );
  }
  if (schemaVersion < 1) {
    return err(`unsupported schemaVersion ${schemaVersion}`);
  }

  // Deterministic migration chain (pure; persistence/backup is the caller's job).
  let migratedValue: unknown = value;
  try {
    const migrated = migrateStateDocument(value);
    migratedValue = migrated.value;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }

  const parsed = fromZod(desiredStateRawSchema.safeParse(migratedValue));
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  const apps: Record<string, AppState> = {};
  for (const [key, appVal] of Object.entries(raw.apps)) {
    if (appVal.slug !== key) {
      return err(`apps.${key}: key must match slug ${appVal.slug}`);
    }
    apps[key] = brandApp(appVal);
  }

  const proxies: Record<string, ProxySite> = {};
  for (const [key, proxyVal] of Object.entries(raw.proxies)) {
    if (proxyVal.name !== key) {
      return err(`proxies.${key}: key must match name ${proxyVal.name}`);
    }
    proxies[key] = brandProxy(proxyVal);
  }

  const domains: Record<string, DomainOwner> = {};
  for (const [key, ownerVal] of Object.entries(raw.domains)) {
    domains[key.toLowerCase()] = brandDomainOwner(ownerVal);
  }

  return ok({
    schemaVersion: STATE_SCHEMA_VERSION,
    defaults: brandDefaults(raw.defaults),
    phpVersions: raw.phpVersions.map(brandPhpVersion),
    mysqlVersions: raw.mysqlVersions.map(brandMysqlVersion),
    apps,
    proxies,
    domains,
    cronJobs: raw.cronJobs.map(brandCron),
    workers: raw.workers.map(brandWorker),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  });
}

/** Load state from JSON text; rejects invalid/future versions without mutation. */
export function loadStateFromJson(text: string): DesiredState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw validationError("state.json is not valid JSON", {
      cause: String(cause),
    });
  }
  const result = parseDesiredState(raw);
  if (!result.ok) {
    throw stateError(`invalid desired state: ${result.errors.join("; ")}`, {
      recovery: "Fix state.json or restore from backup. Bento will not overwrite invalid state.",
    });
  }
  return result.value;
}

export function stateToJson(state: DesiredState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function emptyStateJson(now?: string): string {
  return stateToJson(createEmptyState(now));
}

export { createEmptyState, unwrap };
