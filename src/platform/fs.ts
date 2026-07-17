import { dirname, join } from "@std/path";
import type { FileMode, FileSystem } from "./interfaces.ts";
import { platformError } from "../domain/errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createFileSystem(): FileSystem {
  return {
    async readText(path: string): Promise<string> {
      try {
        return await Deno.readTextFile(path);
      } catch (cause) {
        throw platformError(`failed to read ${path}`, cause);
      }
    },

    async readBytes(path: string): Promise<Uint8Array> {
      try {
        return await Deno.readFile(path);
      } catch (cause) {
        throw platformError(`failed to read ${path}`, cause);
      }
    },

    async writeText(path: string, content: string, mode?: FileMode): Promise<void> {
      await this.writeBytes(path, encoder.encode(content), mode);
    },

    async writeBytes(path: string, content: Uint8Array, mode?: FileMode): Promise<void> {
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeFile(path, content);
        if (mode !== undefined) await Deno.chmod(path, mode);
      } catch (cause) {
        throw platformError(`failed to write ${path}`, cause);
      }
    },

    async appendText(path: string, content: string): Promise<void> {
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(path, content, { append: true });
      } catch (cause) {
        throw platformError(`failed to append ${path}`, cause);
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        await Deno.lstat(path);
        return true;
      } catch {
        return false;
      }
    },

    async mkdirp(path: string, mode?: FileMode): Promise<void> {
      try {
        await Deno.mkdir(path, { recursive: true });
        if (mode !== undefined) await Deno.chmod(path, mode);
      } catch (cause) {
        throw platformError(`failed to create directory ${path}`, cause);
      }
    },

    async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
      try {
        await Deno.remove(path, { recursive: opts?.recursive ?? false });
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) return;
        throw platformError(`failed to remove ${path}`, cause);
      }
    },

    async rename(from: string, to: string): Promise<void> {
      try {
        await Deno.mkdir(dirname(to), { recursive: true });
        await Deno.rename(from, to);
      } catch (cause) {
        throw platformError(`failed to rename ${from} -> ${to}`, cause);
      }
    },

    async chmod(path: string, mode: FileMode): Promise<void> {
      try {
        await Deno.chmod(path, mode);
      } catch (cause) {
        throw platformError(`failed to chmod ${path}`, cause);
      }
    },

    async copyFile(from: string, to: string): Promise<void> {
      try {
        await Deno.mkdir(dirname(to), { recursive: true });
        await Deno.copyFile(from, to);
      } catch (cause) {
        throw platformError(`failed to copy ${from} -> ${to}`, cause);
      }
    },

    async readDir(path: string): Promise<string[]> {
      try {
        const names: string[] = [];
        for await (const entry of Deno.readDir(path)) {
          names.push(entry.name);
        }
        return names.sort();
      } catch (cause) {
        throw platformError(`failed to read directory ${path}`, cause);
      }
    },

    async stat(
      path: string,
    ): Promise<{
      isFile: boolean;
      isDirectory: boolean;
      mode: number;
      size: number;
      modifiedAt: Date | null;
    }> {
      try {
        const s = await Deno.stat(path);
        return {
          isFile: s.isFile,
          isDirectory: s.isDirectory,
          mode: s.mode ?? 0,
          size: s.size,
          modifiedAt: s.mtime,
        };
      } catch (cause) {
        throw platformError(`failed to stat ${path}`, cause);
      }
    },

    async lstat(
      path: string,
    ): Promise<{
      isFile: boolean;
      isDirectory: boolean;
      isSymlink: boolean;
      mode: number;
      size: number;
    }> {
      try {
        const s = await Deno.lstat(path);
        return {
          isFile: s.isFile,
          isDirectory: s.isDirectory,
          isSymlink: s.isSymlink,
          mode: s.mode ?? 0,
          size: s.size,
        };
      } catch (cause) {
        throw platformError(`failed to lstat ${path}`, cause);
      }
    },

    async atomicWriteText(path: string, content: string, mode?: FileMode): Promise<void> {
      await this.atomicWriteBytes(path, encoder.encode(content), mode);
    },

    async atomicWriteBytes(
      path: string,
      content: Uint8Array,
      mode?: FileMode,
    ): Promise<void> {
      const dir = dirname(path);
      await Deno.mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
      try {
        await Deno.writeFile(tmp, content);
        if (mode !== undefined) await Deno.chmod(tmp, mode);
        await Deno.rename(tmp, path);
      } catch (cause) {
        try {
          await Deno.remove(tmp);
        } catch {
          // ignore cleanup failure
        }
        throw platformError(`failed atomic write to ${path}`, cause);
      }
    },
  };
}

export { decoder, encoder };
