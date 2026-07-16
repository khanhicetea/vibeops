/**
 * Runtime schema for desired state JSON.
 * bytes -> JSON unknown -> version discriminator -> validation -> migration -> DesiredState
 */

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
  FPM_PROFILES,
} from "../domain/types.ts";
import { STATE_SCHEMA_VERSION } from "../version.ts";
import { stateError, validationError } from "../domain/errors.ts";
import {
  asBoolean,
  asNonEmptyString,
  asOptional,
  asString,
  err,
  isObject,
  ok,
  oneOf,
  parseAppSlug,
  parseCronSchedule,
  parseDomainName,
  parseIsoDate,
  parseMysqlVersion,
  parsePhpVersion,
  parsePositiveInt,
  type ParseResult,
  parseSafeRelativePath,
  parseStringArray,
  parseUidGid,
  unwrap,
} from "./validators.ts";

function parseTlsMode(value: unknown, field: string): ParseResult<TlsMode> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const kind = oneOf(value.kind, `${field}.kind`, ["boot", "acme", "external"] as const);
  if (!kind.ok) return kind;
  if (kind.value === "boot") return ok({ kind: "boot" });
  if (kind.value === "acme") {
    const email = asOptional(value.email, (v) => asNonEmptyString(v, `${field}.email`));
    if (!email.ok) return email;
    return ok({ kind: "acme", ...(email.value ? { email: email.value } : {}) });
  }
  const certPath = asNonEmptyString(value.certPath, `${field}.certPath`);
  const keyPath = asNonEmptyString(value.keyPath, `${field}.keyPath`);
  if (!certPath.ok) return certPath;
  if (!keyPath.ok) return keyPath;
  return ok({ kind: "external", certPath: certPath.value, keyPath: keyPath.value });
}

function parseTemplateProvenance(
  value: unknown,
  field: string,
): ParseResult<TemplateProvenance> {
  if (value === undefined || value === null) return ok({ kind: "upstream" });
  if (!isObject(value)) return err(`${field} must be an object`);
  const kind = oneOf(value.kind, `${field}.kind`, ["upstream", "custom"] as const);
  if (!kind.ok) return kind;
  if (kind.value === "upstream") return ok({ kind: "upstream" });
  const sourcePath = asNonEmptyString(value.sourcePath, `${field}.sourcePath`);
  if (!sourcePath.ok) return sourcePath;
  const activatedAt = parseIsoDate(value.activatedAt, `${field}.activatedAt`);
  if (!activatedAt.ok) return activatedAt;
  const copiedFromVersion = asOptional(
    value.copiedFromVersion,
    (v) => asNonEmptyString(v, `${field}.copiedFromVersion`),
  );
  if (!copiedFromVersion.ok) return copiedFromVersion;
  return ok({
    kind: "custom",
    sourcePath: sourcePath.value,
    activatedAt: activatedAt.value,
    ...(copiedFromVersion.value ? { copiedFromVersion: copiedFromVersion.value } : {}),
  });
}

function parseDeploy(value: unknown, field: string): ParseResult<AppDeployConfig> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const enabled = asBoolean(value.enabled, `${field}.enabled`);
  if (!enabled.ok) return enabled;
  const queuePolicy = oneOf(
    value.queuePolicy ?? "latest",
    `${field}.queuePolicy`,
    [
      "latest",
      "fifo",
    ] as const,
  );
  if (!queuePolicy.ok) return queuePolicy;
  const timeoutSec = parsePositiveInt(value.timeoutSec ?? 900, `${field}.timeoutSec`);
  if (!timeoutSec.ok) return timeoutSec;
  const workdir = asNonEmptyString(value.workdir, `${field}.workdir`);
  if (!workdir.ok) return workdir;
  const argv = parseStringArray(value.argv, `${field}.argv`);
  if (!argv.ok) return argv;
  if (argv.value.length === 0) return err(`${field}.argv must not be empty`);
  const hmacSecret = asOptional(
    value.hmacSecret,
    (v) => asNonEmptyString(v, `${field}.hmacSecret`),
  );
  if (!hmacSecret.ok) return hmacSecret;
  return ok({
    enabled: enabled.value,
    queuePolicy: queuePolicy.value as QueuePolicy,
    timeoutSec: timeoutSec.value,
    workdir: workdir.value,
    argv: argv.value,
    ...(hmacSecret.value ? { hmacSecret: hmacSecret.value } : {}),
  });
}

function parseRedis(
  value: unknown,
  field: string,
): ParseResult<AppRedisIdentity> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const mode = oneOf(value.mode, `${field}.mode`, ["shared", "acl"] as const);
  if (!mode.ok) return mode;
  const prefix = asNonEmptyString(value.prefix, `${field}.prefix`);
  if (!prefix.ok) return prefix;
  const password = asOptional(value.password, (v) => asString(v, `${field}.password`));
  if (!password.ok) return password;
  const aclUsername = asOptional(
    value.aclUsername,
    (v) => asNonEmptyString(v, `${field}.aclUsername`),
  );
  if (!aclUsername.ok) return aclUsername;
  const aclPassword = asOptional(
    value.aclPassword,
    (v) => asString(v, `${field}.aclPassword`),
  );
  if (!aclPassword.ok) return aclPassword;
  return ok({
    mode: mode.value as RedisMode,
    prefix: prefix.value,
    ...(password.value !== undefined ? { password: password.value } : {}),
    ...(aclUsername.value ? { aclUsername: aclUsername.value } : {}),
    ...(aclPassword.value !== undefined ? { aclPassword: aclPassword.value } : {}),
  });
}

function parseDatabase(value: unknown, field: string): ParseResult<AppDatabase> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const name = asNonEmptyString(value.name, `${field}.name`);
  if (!name.ok) return name;
  if (!/^[a-zA-Z0-9_]+$/.test(name.value)) {
    return err(`${field}.name must be alphanumeric/underscore`);
  }
  const createdAt = parseIsoDate(value.createdAt, `${field}.createdAt`);
  if (!createdAt.ok) return createdAt;
  return ok({ name: asDatabaseName(name.value), createdAt: createdAt.value });
}

function parseApp(value: unknown, field: string): ParseResult<AppState> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const slug = parseAppSlug(value.slug, `${field}.slug`);
  if (!slug.ok) return slug;
  const uid = parseUidGid(value.uid, `${field}.uid`);
  if (!uid.ok) return uid;
  const gid = parseUidGid(value.gid, `${field}.gid`);
  if (!gid.ok) return gid;
  const home = asNonEmptyString(value.home, `${field}.home`);
  if (!home.ok) return home;
  if (!home.value.startsWith("/")) return err(`${field}.home must be absolute`);
  const mainDomain = parseDomainName(value.mainDomain, `${field}.mainDomain`);
  if (!mainDomain.ok) return mainDomain;
  const aliasesRaw = parseStringArray(value.aliases ?? [], `${field}.aliases`);
  if (!aliasesRaw.ok) return aliasesRaw;
  const aliases: string[] = [];
  for (let i = 0; i < aliasesRaw.value.length; i++) {
    const a = parseDomainName(aliasesRaw.value[i], `${field}.aliases[${i}]`);
    if (!a.ok) return a;
    aliases.push(a.value);
  }
  const documentRoot = parseSafeRelativePath(
    value.documentRoot ?? "",
    `${field}.documentRoot`,
  );
  if (!documentRoot.ok) return documentRoot;
  const entrypointMode = oneOf(
    value.entrypointMode,
    `${field}.entrypointMode`,
    ["front-controller", "legacy"] as const,
  );
  if (!entrypointMode.ok) return entrypointMode;
  const phpVersion = parsePhpVersion(value.phpVersion, `${field}.phpVersion`);
  if (!phpVersion.ok) return phpVersion;
  const phpService = asNonEmptyString(value.phpService, `${field}.phpService`);
  if (!phpService.ok) return phpService;
  const fpmProfile = asNonEmptyString(value.fpmProfile, `${field}.fpmProfile`);
  if (!fpmProfile.ok) return fpmProfile;
  if (!(fpmProfile.value in FPM_PROFILES)) {
    return err(
      `${field}.fpmProfile must be one of: ${Object.keys(FPM_PROFILES).join(", ")}`,
    );
  }
  const tls = parseTlsMode(value.tls, `${field}.tls`);
  if (!tls.ok) return tls;
  const accessLog = asBoolean(value.accessLog ?? false, `${field}.accessLog`);
  if (!accessLog.ok) return accessLog;
  const mysqlService = asNonEmptyString(value.mysqlService, `${field}.mysqlService`);
  if (!mysqlService.ok) return mysqlService;
  const mysqlUser = asNonEmptyString(value.mysqlUser, `${field}.mysqlUser`);
  if (!mysqlUser.ok) return mysqlUser;
  const mysqlPassword = asString(value.mysqlPassword, `${field}.mysqlPassword`);
  if (!mysqlPassword.ok) return mysqlPassword;
  const dbsRaw = value.databases ?? [];
  if (!Array.isArray(dbsRaw)) return err(`${field}.databases must be an array`);
  const databases: AppDatabase[] = [];
  for (let i = 0; i < dbsRaw.length; i++) {
    const db = parseDatabase(dbsRaw[i], `${field}.databases[${i}]`);
    if (!db.ok) return db;
    databases.push(db.value);
  }
  const redis = parseRedis(value.redis, `${field}.redis`);
  if (!redis.ok) return redis;
  const deploy = parseDeploy(value.deploy, `${field}.deploy`);
  if (!deploy.ok) return deploy;
  const vhostTemplate = parseTemplateProvenance(
    value.vhostTemplate,
    `${field}.vhostTemplate`,
  );
  if (!vhostTemplate.ok) return vhostTemplate;
  const poolTemplate = parseTemplateProvenance(
    value.poolTemplate,
    `${field}.poolTemplate`,
  );
  if (!poolTemplate.ok) return poolTemplate;
  const createdAt = parseIsoDate(value.createdAt, `${field}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseIsoDate(value.updatedAt, `${field}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;

  return ok({
    slug: asAppSlug(slug.value),
    uid: asUid(uid.value),
    gid: asGid(gid.value),
    home: asAbsoluteAppPath(home.value),
    mainDomain: asDomainName(mainDomain.value),
    aliases: aliases.map(asDomainName),
    documentRoot: documentRoot.value,
    entrypointMode: entrypointMode.value as EntrypointMode,
    phpVersion: asPhpVersion(phpVersion.value),
    phpService: phpService.value,
    fpmProfile: asFpmProfile(fpmProfile.value),
    tls: tls.value,
    accessLog: accessLog.value,
    mysqlService: asMysqlService(mysqlService.value),
    mysqlUser: mysqlUser.value,
    mysqlPassword: mysqlPassword.value,
    databases,
    redis: redis.value,
    deploy: deploy.value,
    vhostTemplate: vhostTemplate.value,
    poolTemplate: poolTemplate.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseProxy(value: unknown, field: string): ParseResult<ProxySite> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const name = parseAppSlug(value.name, `${field}.name`);
  if (!name.ok) return name;
  const mainDomain = parseDomainName(value.mainDomain, `${field}.mainDomain`);
  if (!mainDomain.ok) return mainDomain;
  const aliasesRaw = parseStringArray(value.aliases ?? [], `${field}.aliases`);
  if (!aliasesRaw.ok) return aliasesRaw;
  const aliases: string[] = [];
  for (let i = 0; i < aliasesRaw.value.length; i++) {
    const a = parseDomainName(aliasesRaw.value[i], `${field}.aliases[${i}]`);
    if (!a.ok) return a;
    aliases.push(a.value);
  }
  const upstream = asNonEmptyString(value.upstream, `${field}.upstream`);
  if (!upstream.ok) return upstream;
  const tls = parseTlsMode(value.tls, `${field}.tls`);
  if (!tls.ok) return tls;
  const accessLog = asBoolean(value.accessLog ?? false, `${field}.accessLog`);
  if (!accessLog.ok) return accessLog;
  const createdAt = parseIsoDate(value.createdAt, `${field}.createdAt`);
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseIsoDate(value.updatedAt, `${field}.updatedAt`);
  if (!updatedAt.ok) return updatedAt;
  return ok({
    name: asProxySiteName(name.value),
    mainDomain: asDomainName(mainDomain.value),
    aliases: aliases.map(asDomainName),
    upstream: upstream.value,
    tls: tls.value,
    accessLog: accessLog.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  });
}

function parseDomainOwner(value: unknown, field: string): ParseResult<DomainOwner> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const kind = oneOf(value.kind, `${field}.kind`, ["app", "proxy"] as const);
  if (!kind.ok) return kind;
  if (kind.value === "app") {
    const slug = parseAppSlug(value.slug, `${field}.slug`);
    if (!slug.ok) return slug;
    return ok({ kind: "app", slug: asAppSlug(slug.value) });
  }
  const name = parseAppSlug(value.name, `${field}.name`);
  if (!name.ok) return name;
  return ok({ kind: "proxy", name: asProxySiteName(name.value) });
}

function parseCronJob(value: unknown, field: string): ParseResult<CronJob> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const name = asNonEmptyString(value.name, `${field}.name`);
  if (!name.ok) return name;
  const app = parseAppSlug(value.app, `${field}.app`);
  if (!app.ok) return app;
  const schedule = parseCronSchedule(value.schedule, `${field}.schedule`);
  if (!schedule.ok) return schedule;
  const timezone = asNonEmptyString(value.timezone ?? "UTC", `${field}.timezone`);
  if (!timezone.ok) return timezone;
  const workdir = asNonEmptyString(value.workdir, `${field}.workdir`);
  if (!workdir.ok) return workdir;
  const command = parseStringArray(value.command, `${field}.command`);
  if (!command.ok) return command;
  if (command.value.length === 0) return err(`${field}.command must not be empty`);
  const output = oneOf(
    value.output ?? "log",
    `${field}.output`,
    [
      "log",
      "null",
      "inherit",
    ] as const,
  );
  if (!output.ok) return output;
  const enabled = asBoolean(value.enabled ?? true, `${field}.enabled`);
  if (!enabled.ok) return enabled;
  const timeoutSec = asOptional(
    value.timeoutSec,
    (v) => parsePositiveInt(v, `${field}.timeoutSec`),
  );
  if (!timeoutSec.ok) return timeoutSec;
  const lock = asOptional(value.lock, (v) => asNonEmptyString(v, `${field}.lock`));
  if (!lock.ok) return lock;
  return ok({
    name: asCronJobName(name.value),
    app: asAppSlug(app.value),
    schedule: schedule.value,
    timezone: timezone.value,
    workdir: workdir.value,
    command: command.value,
    output: output.value,
    enabled: enabled.value,
    ...(timeoutSec.value !== undefined ? { timeoutSec: timeoutSec.value } : {}),
    ...(lock.value ? { lock: lock.value } : {}),
  });
}

function parseWorker(value: unknown, field: string): ParseResult<Worker> {
  if (!isObject(value)) return err(`${field} must be an object`);
  const name = asNonEmptyString(value.name, `${field}.name`);
  if (!name.ok) return name;
  const app = parseAppSlug(value.app, `${field}.app`);
  if (!app.ok) return app;
  const command = parseStringArray(value.command, `${field}.command`);
  if (!command.ok) return command;
  if (command.value.length === 0) return err(`${field}.command must not be empty`);
  const workdir = asNonEmptyString(value.workdir, `${field}.workdir`);
  if (!workdir.ok) return workdir;
  const enabled = asBoolean(value.enabled ?? true, `${field}.enabled`);
  if (!enabled.ok) return enabled;
  const autorestart = asBoolean(value.autorestart ?? true, `${field}.autorestart`);
  if (!autorestart.ok) return autorestart;
  const stopsignal = asNonEmptyString(value.stopsignal ?? "TERM", `${field}.stopsignal`);
  if (!stopsignal.ok) return stopsignal;
  const stopwaitsecs = parsePositiveInt(value.stopwaitsecs ?? 10, `${field}.stopwaitsecs`);
  if (!stopwaitsecs.ok) return stopwaitsecs;
  return ok({
    name: asWorkerName(name.value),
    app: asAppSlug(app.value),
    command: command.value,
    workdir: workdir.value,
    enabled: enabled.value,
    autorestart: autorestart.value,
    stopsignal: stopsignal.value,
    stopwaitsecs: stopwaitsecs.value,
  });
}

function parseDefaults(value: unknown): ParseResult<StackDefaults> {
  if (!isObject(value)) return err("defaults must be an object");
  const phpVersion = parsePhpVersion(value.phpVersion, "defaults.phpVersion");
  if (!phpVersion.ok) return phpVersion;
  const mysqlVersion = parseMysqlVersion(value.mysqlVersion, "defaults.mysqlVersion");
  if (!mysqlVersion.ok) return mysqlVersion;
  const fpmProfile = asNonEmptyString(value.fpmProfile, "defaults.fpmProfile");
  if (!fpmProfile.ok) return fpmProfile;
  if (!(fpmProfile.value in FPM_PROFILES)) {
    return err(`defaults.fpmProfile must be one of: ${Object.keys(FPM_PROFILES).join(", ")}`);
  }
  const redisMode = oneOf(
    value.redisMode ?? "shared",
    "defaults.redisMode",
    [
      "shared",
      "acl",
    ] as const,
  );
  if (!redisMode.ok) return redisMode;
  return ok({
    phpVersion: asPhpVersion(phpVersion.value),
    mysqlVersion: asMysqlVersion(mysqlVersion.value),
    fpmProfile: asFpmProfile(fpmProfile.value),
    redisMode: redisMode.value as RedisMode,
  });
}

function parsePhpVersions(value: unknown): ParseResult<ManagedPhpVersion[]> {
  if (!Array.isArray(value)) return err("phpVersions must be an array");
  if (value.length === 0) return err("phpVersions must not be empty");
  const out: ManagedPhpVersion[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isObject(item)) return err(`phpVersions[${i}] must be an object`);
    const version = parsePhpVersion(item.version, `phpVersions[${i}].version`);
    if (!version.ok) return version;
    const service = asNonEmptyString(item.service, `phpVersions[${i}].service`);
    if (!service.ok) return service;
    const image = asNonEmptyString(item.image, `phpVersions[${i}].image`);
    if (!image.ok) return image;
    const processCap = parsePositiveInt(
      item.processCap ?? 200,
      `phpVersions[${i}].processCap`,
    );
    if (!processCap.ok) return processCap;
    out.push({
      version: asPhpVersion(version.value),
      service: service.value,
      image: image.value,
      processCap: processCap.value,
    });
  }
  return ok(out);
}

function parseMysqlVersions(value: unknown): ParseResult<ManagedMysqlVersion[]> {
  if (!Array.isArray(value)) return err("mysqlVersions must be an array");
  if (value.length === 0) return err("mysqlVersions must not be empty");
  const out: ManagedMysqlVersion[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isObject(item)) return err(`mysqlVersions[${i}] must be an object`);
    const version = parseMysqlVersion(item.version, `mysqlVersions[${i}].version`);
    if (!version.ok) return version;
    const service = asNonEmptyString(item.service, `mysqlVersions[${i}].service`);
    if (!service.ok) return service;
    const image = asNonEmptyString(item.image, `mysqlVersions[${i}].image`);
    if (!image.ok) return image;
    const volume = asNonEmptyString(item.volume, `mysqlVersions[${i}].volume`);
    if (!volume.ok) return volume;
    out.push({
      version: asMysqlVersion(version.value),
      service: asMysqlService(service.value),
      image: image.value,
      volume: volume.value,
    });
  }
  return ok(out);
}

/** Parse unknown JSON into DesiredState for the current schema version. */
export function parseDesiredState(value: unknown): ParseResult<DesiredState> {
  if (!isObject(value)) return err("state must be a JSON object");

  const schemaVersion = value.schemaVersion;
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
  // Migrations for older versions would run here. v1 is current.

  const defaults = parseDefaults(value.defaults);
  if (!defaults.ok) return defaults;
  const phpVersions = parsePhpVersions(value.phpVersions);
  if (!phpVersions.ok) return phpVersions;
  const mysqlVersions = parseMysqlVersions(value.mysqlVersions);
  if (!mysqlVersions.ok) return mysqlVersions;

  if (!isObject(value.apps)) return err("apps must be an object");
  const apps: Record<string, AppState> = {};
  for (const [key, appVal] of Object.entries(value.apps)) {
    const app = parseApp(appVal, `apps.${key}`);
    if (!app.ok) return app;
    if (app.value.slug !== key) {
      return err(`apps.${key}: key must match slug ${app.value.slug}`);
    }
    apps[key] = app.value;
  }

  if (!isObject(value.proxies)) return err("proxies must be an object");
  const proxies: Record<string, ProxySite> = {};
  for (const [key, proxyVal] of Object.entries(value.proxies)) {
    const proxy = parseProxy(proxyVal, `proxies.${key}`);
    if (!proxy.ok) return proxy;
    if (proxy.value.name !== key) {
      return err(`proxies.${key}: key must match name ${proxy.value.name}`);
    }
    proxies[key] = proxy.value;
  }

  if (!isObject(value.domains)) return err("domains must be an object");
  const domains: Record<string, DomainOwner> = {};
  for (const [key, ownerVal] of Object.entries(value.domains)) {
    const owner = parseDomainOwner(ownerVal, `domains.${key}`);
    if (!owner.ok) return owner;
    domains[key.toLowerCase()] = owner.value;
  }

  if (!Array.isArray(value.cronJobs)) return err("cronJobs must be an array");
  const cronJobs: CronJob[] = [];
  for (let i = 0; i < value.cronJobs.length; i++) {
    const job = parseCronJob(value.cronJobs[i], `cronJobs[${i}]`);
    if (!job.ok) return job;
    cronJobs.push(job.value);
  }

  if (!Array.isArray(value.workers)) return err("workers must be an array");
  const workers: Worker[] = [];
  for (let i = 0; i < value.workers.length; i++) {
    const w = parseWorker(value.workers[i], `workers[${i}]`);
    if (!w.ok) return w;
    workers.push(w.value);
  }

  const createdAt = parseIsoDate(value.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseIsoDate(value.updatedAt, "updatedAt");
  if (!updatedAt.ok) return updatedAt;

  return ok({
    schemaVersion: STATE_SCHEMA_VERSION,
    defaults: defaults.value,
    phpVersions: phpVersions.value,
    mysqlVersions: mysqlVersions.value,
    apps,
    proxies,
    domains,
    cronJobs,
    workers,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
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
