import { dirname } from "@std/path";
import type { FileLock } from "./interfaces.ts";
import { platformError } from "../domain/errors.ts";

/**
 * Exclusive/shared file locks using Deno flock on a lock file.
 * Suitable for serializing state/render mutations and deploy queue access.
 */
export function createFileLock(): FileLock {
  async function openLock(path: string): Promise<Deno.FsFile> {
    await Deno.mkdir(dirname(path), { recursive: true });
    return await Deno.open(path, { create: true, read: true, write: true });
  }

  return {
    async exclusive(path: string): Promise<() => Promise<void>> {
      let file: Deno.FsFile;
      try {
        file = await openLock(path);
        await file.lock(true);
      } catch (cause) {
        throw platformError(`failed to acquire exclusive lock ${path}`, cause);
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await file.unlock();
        } finally {
          file.close();
        }
      };
    },

    async shared(path: string): Promise<() => Promise<void>> {
      let file: Deno.FsFile;
      try {
        file = await openLock(path);
        await file.lock(false);
      } catch (cause) {
        throw platformError(`failed to acquire shared lock ${path}`, cause);
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await file.unlock();
        } finally {
          file.close();
        }
      };
    },
  };
}

/** In-memory lock for unit tests. */
export function createMemoryLock(): FileLock {
  const exclusiveOwners = new Map<string, number>();
  const sharedCounts = new Map<string, number>();
  let waiters: Array<() => void> = [];

  function notify() {
    const current = waiters;
    waiters = [];
    for (const w of current) w();
  }

  async function waitUntil(pred: () => boolean): Promise<void> {
    while (!pred()) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  return {
    async exclusive(path: string): Promise<() => Promise<void>> {
      await waitUntil(
        () => !exclusiveOwners.has(path) && (sharedCounts.get(path) ?? 0) === 0,
      );
      exclusiveOwners.set(path, 1);
      return async () => {
        exclusiveOwners.delete(path);
        notify();
      };
    },
    async shared(path: string): Promise<() => Promise<void>> {
      await waitUntil(() => !exclusiveOwners.has(path));
      sharedCounts.set(path, (sharedCounts.get(path) ?? 0) + 1);
      return async () => {
        const n = (sharedCounts.get(path) ?? 1) - 1;
        if (n <= 0) sharedCounts.delete(path);
        else sharedCounts.set(path, n);
        notify();
      };
    },
  };
}
