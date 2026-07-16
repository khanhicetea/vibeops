/**
 * Domain model for Bento desired state.
 * This is the authoritative in-memory representation after schema validation/migration.
 */

import type {
  AbsoluteAppPath,
  AppSlug,
  CronJobName,
  DatabaseName,
  DomainName,
  FpmProfile,
  Gid,
  MysqlService,
  MysqlVersion,
  PhpVersion,
  ProxySiteName,
  Uid,
  WorkerName,
} from "./types.ts";
import {
  asFpmProfile,
  asMysqlService,
  asMysqlVersion,
  asPhpVersion,
  DEFAULT_FPM_PROFILE,
  DEFAULT_MYSQL_VERSION,
  DEFAULT_PHP_VERSION,
} from "./types.ts";
import { STATE_SCHEMA_VERSION } from "../version.ts";

export type TlsMode =
  | { kind: "boot" }
  | { kind: "acme"; email?: string }
  | { kind: "external"; certPath: string; keyPath: string };

export type EntrypointMode = "front-controller" | "legacy";
export type RedisMode = "shared" | "acl";
export type QueuePolicy = "latest" | "fifo";
export type DeployStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export type TemplateProvenance =
  | { kind: "upstream" }
  | {
    kind: "custom";
    sourcePath: string;
    copiedFromVersion?: string;
    activatedAt: string;
  };

export type DomainOwner =
  | { kind: "app"; slug: AppSlug }
  | { kind: "proxy"; name: ProxySiteName };

export type AppDeployConfig = {
  enabled: boolean;
  hmacSecret?: string;
  queuePolicy: QueuePolicy;
  timeoutSec: number;
  workdir: string;
  argv: string[];
};

export type AppRedisIdentity = {
  mode: RedisMode;
  prefix: string;
  password?: string;
  aclUsername?: string;
  aclPassword?: string;
};

export type AppDatabase = {
  name: DatabaseName;
  createdAt: string;
};

export type AppState = {
  slug: AppSlug;
  uid: Uid;
  gid: Gid;
  home: AbsoluteAppPath;
  mainDomain: DomainName;
  aliases: DomainName[];
  documentRoot: string;
  entrypointMode: EntrypointMode;
  phpVersion: PhpVersion;
  phpService: string;
  fpmProfile: FpmProfile;
  tls: TlsMode;
  accessLog: boolean;
  mysqlService: MysqlService;
  mysqlUser: string;
  mysqlPassword: string;
  databases: AppDatabase[];
  redis: AppRedisIdentity;
  deploy: AppDeployConfig;
  vhostTemplate: TemplateProvenance;
  poolTemplate: TemplateProvenance;
  createdAt: string;
  updatedAt: string;
};

export type ProxySite = {
  name: ProxySiteName;
  mainDomain: DomainName;
  aliases: DomainName[];
  upstream: string;
  tls: TlsMode;
  accessLog: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CronJob = {
  name: CronJobName;
  app: AppSlug;
  schedule: string;
  timezone: string;
  workdir: string;
  command: string[];
  output: "log" | "null" | "inherit";
  timeoutSec?: number;
  lock?: string;
  enabled: boolean;
};

export type Worker = {
  name: WorkerName;
  app: AppSlug;
  command: string[];
  workdir: string;
  enabled: boolean;
  autorestart: boolean;
  stopsignal: string;
  stopwaitsecs: number;
};

export type StackDefaults = {
  phpVersion: PhpVersion;
  mysqlVersion: MysqlVersion;
  fpmProfile: FpmProfile;
  redisMode: RedisMode;
};

export type ManagedPhpVersion = {
  version: PhpVersion;
  service: string;
  image: string;
  processCap: number;
};

export type ManagedMysqlVersion = {
  version: MysqlVersion;
  service: MysqlService;
  image: string;
  volume: string;
};

export type DesiredState = {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  defaults: StackDefaults;
  phpVersions: ManagedPhpVersion[];
  mysqlVersions: ManagedMysqlVersion[];
  apps: Record<string, AppState>;
  proxies: Record<string, ProxySite>;
  domains: Record<string, DomainOwner>;
  cronJobs: CronJob[];
  workers: Worker[];
  createdAt: string;
  updatedAt: string;
};

export function phpServiceName(version: PhpVersion): string {
  return `php${String(version).replace(".", "")}`;
}

export function mysqlServiceName(version: MysqlVersion): MysqlService {
  return asMysqlService(`mysql${String(version).replace(".", "")}`);
}

export function phpImage(version: PhpVersion): string {
  // Tag used by compose build; one image serves FPM, runner, and CLI roles.
  return `bento/php:${version}`;
}

export function mysqlImage(version: MysqlVersion): string {
  return `mysql:${version}`;
}

export function createEmptyState(now: string = new Date().toISOString()): DesiredState {
  const php = DEFAULT_PHP_VERSION;
  const mysql = DEFAULT_MYSQL_VERSION;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    defaults: {
      phpVersion: php,
      mysqlVersion: mysql,
      fpmProfile: DEFAULT_FPM_PROFILE,
      redisMode: "shared",
    },
    phpVersions: [
      {
        version: php,
        service: phpServiceName(php),
        image: phpImage(php),
        processCap: 200,
      },
    ],
    mysqlVersions: [
      {
        version: mysql,
        service: mysqlServiceName(mysql),
        image: mysqlImage(mysql),
        volume: `bento-${mysqlServiceName(mysql)}-data`,
      },
    ],
    apps: {},
    proxies: {},
    domains: {},
    cronJobs: [],
    workers: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function listApps(state: DesiredState): AppState[] {
  return Object.values(state.apps).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getApp(state: DesiredState, slug: string): AppState | undefined {
  return state.apps[slug];
}

export function findDomainOwner(
  state: DesiredState,
  domain: string,
): DomainOwner | undefined {
  return state.domains[domain.toLowerCase()];
}

export function assertKnownPhpVersion(state: DesiredState, version: PhpVersion): ManagedPhpVersion {
  const found = state.phpVersions.find((v) => v.version === version);
  if (!found) {
    throw new Error(`PHP version ${version} is not managed`);
  }
  return found;
}

export function assertKnownMysqlService(
  state: DesiredState,
  service: MysqlService,
): ManagedMysqlVersion {
  const found = state.mysqlVersions.find((v) => v.service === service);
  if (!found) {
    throw new Error(`MySQL service ${service} is not managed`);
  }
  return found;
}

export function cloneState(state: DesiredState): DesiredState {
  return structuredClone(state);
}

export function defaultDeployConfig(appHome: string): AppDeployConfig {
  return {
    enabled: false,
    queuePolicy: "latest",
    timeoutSec: 900,
    workdir: appHome,
    argv: ["sh", `${appHome}/.bento/deploy.sh`],
  };
}

export function defaultRedisIdentity(slug: string, mode: RedisMode): AppRedisIdentity {
  const prefix = `${slug}:`;
  if (mode === "acl") {
    return {
      mode: "acl",
      prefix,
      aclUsername: `app_${slug}`,
    };
  }
  return {
    mode: "shared",
    prefix,
  };
}

/** Re-export helpers used by services. */
export { asFpmProfile, asMysqlService, asMysqlVersion, asPhpVersion };
