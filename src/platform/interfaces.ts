/**
 * Narrow platform interfaces injected into domain services.
 * Domain code must not import Deno.* directly.
 */

export type FileMode = number;

export type FileSnapshot = {
  path: string;
  content: Uint8Array;
  mode: FileMode;
  existed: boolean;
};

export type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export interface Random {
  bytes(length: number): Uint8Array;
  hex(length: number): string;
  id(prefix?: string): string;
}

export interface FileSystem {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string, mode?: FileMode): Promise<void>;
  writeBytes(path: string, content: Uint8Array, mode?: FileMode): Promise<void>;
  appendText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string, mode?: FileMode): Promise<void>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: FileMode): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  readDir(path: string): Promise<string[]>;
  stat(
    path: string,
  ): Promise<{ isFile: boolean; isDirectory: boolean; mode: number; size: number }>;
  /**
   * lstat does not follow symlinks. Use this when walking trees so repair/check
   * never chases symlink targets outside the app home.
   */
  lstat(
    path: string,
  ): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    isSymlink: boolean;
    mode: number;
    size: number;
  }>;
  /** Atomic write via temp file + rename on same filesystem. */
  atomicWriteText(path: string, content: string, mode?: FileMode): Promise<void>;
  atomicWriteBytes(path: string, content: Uint8Array, mode?: FileMode): Promise<void>;
}

export interface FileLock {
  /** Acquire exclusive lock; returns release function. */
  exclusive(path: string): Promise<() => Promise<void>>;
  /** Acquire shared lock; returns release function. */
  shared(path: string): Promise<() => Promise<void>>;
}

export interface ProcessRunner {
  run(command: string[], options?: RunOptions): Promise<RunResult>;
}

export interface AssetResolver {
  /** Read an immutable asset (template, helper, compose base). */
  readText(assetPath: string): Promise<string>;
  readBytes(assetPath: string): Promise<Uint8Array>;
  /** Materialize asset tree to a host path for Docker/Compose. */
  materialize(assetPath: string, destDir: string): Promise<string>;
  /** Digest of embedded/source assets for parity tracking. */
  digest(): Promise<string>;
}

export type StackPaths = {
  /** Operator-selected stack root (mutable/desired/durable). */
  root: string;
  stateFile: string;
  envFile: string;
  generatedDir: string;
  lockDir: string;
  renderLock: string;
  journalFile: string;
  stagingDir: string;
  composeDir: string;
  nginxDir: string;
  phpDir: string;
  mysqlDir: string;
  runnerDir: string;
  secretsDir: string;
  backupsDir: string;
  certsDir: string;
  customDir: string;
  overlaysDir: string;
  homesDir: string;
  assetCacheDir: string;
  logsDir: string;
};

export interface PathPolicy {
  paths: StackPaths;
  /** Ensure workdir stays inside app home. */
  assertInsideHome(home: string, workdir: string): string;
  appHome(slug: string): string;
  appSocket(phpService: string, slug: string): string;
  hostSocket(phpService: string, slug: string): string;
}

export type Platform = {
  clock: Clock;
  random: Random;
  fs: FileSystem;
  lock: FileLock;
  process: ProcessRunner;
  assets: AssetResolver;
  paths: PathPolicy;
};
