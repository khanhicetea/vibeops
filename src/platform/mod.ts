import type { Platform } from "./interfaces.ts";
import { createClock } from "./clock.ts";
import { createRandom } from "./random.ts";
import { createFileSystem } from "./fs.ts";
import { createFileLock } from "./lock.ts";
import { createProcessRunner } from "./process.ts";
import { createAssetResolver } from "./assets.ts";
import { createPathPolicy } from "./paths.ts";

export type { Platform } from "./interfaces.ts";
export type {
  AssetResolver,
  Clock,
  FileLock,
  FileSystem,
  PathPolicy,
  ProcessRunner,
  Random,
  RunOptions,
  RunResult,
  StackPaths,
} from "./interfaces.ts";

export { createClock, createFixedClock } from "./clock.ts";
export { createRandom, createSeededRandom } from "./random.ts";
export { createFileSystem } from "./fs.ts";
export { createFileLock, createMemoryLock } from "./lock.ts";
export { createProcessRunner, createRecordingProcessRunner } from "./process.ts";
export { createAssetResolver } from "./assets.ts";
export { containerAppHome, createPathPolicy, resolveStackPaths } from "./paths.ts";

/** Build the default production platform for a stack root. */
export function createPlatform(stackRoot: string, repoRoot?: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createClock(),
    random: createRandom(),
    fs,
    lock: createFileLock(),
    process: createProcessRunner(),
    assets: createAssetResolver(fs, repoRoot),
    paths: createPathPolicy(stackRoot),
  };
}
