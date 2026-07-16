/**
 * Branded/opaque domain value types.
 * These prevent accidental mixing of string-like primitives at compile time.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AppSlug = Brand<string, "AppSlug">;
export type DomainName = Brand<string, "DomainName">;
export type Uid = Brand<number, "Uid">;
export type Gid = Brand<number, "Gid">;
export type PhpVersion = Brand<string, "PhpVersion">;
export type MysqlVersion = Brand<string, "MysqlVersion">;
export type MysqlService = Brand<string, "MysqlService">;
export type AbsoluteAppPath = Brand<string, "AbsoluteAppPath">;
export type UnixSocketPath = Brand<string, "UnixSocketPath">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
export type FpmProfile = Brand<string, "FpmProfile">;
export type WorkerName = Brand<string, "WorkerName">;
export type CronJobName = Brand<string, "CronJobName">;
export type DeployJobId = Brand<string, "DeployJobId">;
export type ProxySiteName = Brand<string, "ProxySiteName">;
export type DatabaseName = Brand<string, "DatabaseName">;

export function asAppSlug(value: string): AppSlug {
  return value as AppSlug;
}
export function asDomainName(value: string): DomainName {
  return value as DomainName;
}
export function asUid(value: number): Uid {
  return value as Uid;
}
export function asGid(value: number): Gid {
  return value as Gid;
}
export function asPhpVersion(value: string): PhpVersion {
  return value as PhpVersion;
}
export function asMysqlVersion(value: string): MysqlVersion {
  return value as MysqlVersion;
}
export function asMysqlService(value: string): MysqlService {
  return value as MysqlService;
}
export function asAbsoluteAppPath(value: string): AbsoluteAppPath {
  return value as AbsoluteAppPath;
}
export function asUnixSocketPath(value: string): UnixSocketPath {
  return value as UnixSocketPath;
}
export function asAbsolutePath(value: string): AbsolutePath {
  return value as AbsolutePath;
}
export function asFpmProfile(value: string): FpmProfile {
  return value as FpmProfile;
}
export function asWorkerName(value: string): WorkerName {
  return value as WorkerName;
}
export function asCronJobName(value: string): CronJobName {
  return value as CronJobName;
}
export function asDeployJobId(value: string): DeployJobId {
  return value as DeployJobId;
}
export function asProxySiteName(value: string): ProxySiteName {
  return value as ProxySiteName;
}
export function asDatabaseName(value: string): DatabaseName {
  return value as DatabaseName;
}

/** Default product policy values. */
export const DEFAULT_PHP_VERSION = asPhpVersion("8.5");
export const DEFAULT_MYSQL_VERSION = asMysqlVersion("8.4");
export const DEFAULT_FPM_PROFILE = asFpmProfile("small");
export const DEFAULT_UID_BASE = 2000;
export const DEFAULT_GID_BASE = 2000;
export const SHARED_SOCKET_GROUP = "bento-web";
export const SHARED_SOCKET_GID = 1500;
export const APP_HOME_ROOT = "/home";

/** Named FPM capacity profiles. */
export const FPM_PROFILES: Readonly<
  Record<string, { maxChildren: number; startServers: number; minSpare: number; maxSpare: number }>
> = {
  tiny: { maxChildren: 5, startServers: 1, minSpare: 1, maxSpare: 3 },
  small: { maxChildren: 10, startServers: 2, minSpare: 1, maxSpare: 5 },
  medium: { maxChildren: 25, startServers: 4, minSpare: 2, maxSpare: 10 },
  large: { maxChildren: 50, startServers: 8, minSpare: 4, maxSpare: 20 },
  xlarge: { maxChildren: 100, startServers: 16, minSpare: 8, maxSpare: 40 },
};

/** Global process cap per PHP version (pm.max_children aggregate warning threshold). */
export const PHP_GLOBAL_PROCESS_CAP = 200;

export const DEPLOY_MAX_BODY_BYTES = 256 * 1024;
export const DEPLOY_MAX_QUEUED = 20;
export const DEPLOY_RETENTION = 30;
export const DEPLOY_DEFAULT_TIMEOUT_SEC = 900;
export const DEPLOY_GRACE_SEC = 30;
