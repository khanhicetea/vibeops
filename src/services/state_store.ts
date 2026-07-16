/**
 * Load/save desired state with exclusive locking and atomic writes.
 */

import type { DesiredState } from "../domain/state.ts";
import { createEmptyState } from "../domain/state.ts";
import { loadStateFromJson, stateToJson } from "../schemas/state.ts";
import type { Platform } from "../platform/mod.ts";
import { stateError } from "../domain/errors.ts";

export class StateStore {
  constructor(private readonly platform: Platform) {}

  async exists(): Promise<boolean> {
    return await this.platform.fs.exists(this.platform.paths.paths.stateFile);
  }

  async load(): Promise<DesiredState> {
    const path = this.platform.paths.paths.stateFile;
    if (!(await this.platform.fs.exists(path))) {
      throw stateError(`no desired state at ${path}`, {
        recovery: "Run `bento init` to create an empty state document.",
      });
    }
    const text = await this.platform.fs.readText(path);
    return loadStateFromJson(text);
  }

  async save(state: DesiredState): Promise<void> {
    const path = this.platform.paths.paths.stateFile;
    const next = {
      ...state,
      updatedAt: this.platform.clock.nowIso(),
    };
    // Validate by round-tripping through schema before write
    const json = stateToJson(next);
    loadStateFromJson(json);
    await this.platform.fs.atomicWriteText(path, json, 0o600);
  }

  /** Initialize empty state if missing; refuse to overwrite. */
  async init(force = false): Promise<DesiredState> {
    const path = this.platform.paths.paths.stateFile;
    if (await this.platform.fs.exists(path) && !force) {
      throw stateError(`state already exists at ${path}`, {
        recovery: "Use --force only if you intentionally want to reset desired state.",
      });
    }
    const state = createEmptyState(this.platform.clock.nowIso());
    await this.platform.fs.mkdirp(this.platform.paths.paths.root);
    await this.platform.fs.mkdirp(this.platform.paths.paths.lockDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.generatedDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.overlaysDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.customDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.backupsDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.certsDir);
    await this.platform.fs.mkdirp(this.platform.paths.paths.homesDir);
    await this.save(state);
    // Seed default env if missing
    const envPath = this.platform.paths.paths.envFile;
    if (!(await this.platform.fs.exists(envPath))) {
      await this.platform.fs.atomicWriteText(
        envPath,
        defaultEnvContent(this.platform.random.hex(24)),
        0o600,
      );
    }
    return state;
  }

  /** Mutate state under exclusive lock. */
  async withExclusive<T>(fn: (state: DesiredState) => Promise<T> | T): Promise<T> {
    const release = await this.platform.lock.exclusive(
      this.platform.paths.paths.renderLock,
    );
    try {
      const state = await this.load();
      return await fn(state);
    } finally {
      await release();
    }
  }

  /** Load under shared lock for read-only operations. */
  async withShared<T>(fn: (state: DesiredState) => Promise<T> | T): Promise<T> {
    const release = await this.platform.lock.shared(
      this.platform.paths.paths.renderLock,
    );
    try {
      const state = await this.load();
      return await fn(state);
    } finally {
      await release();
    }
  }
}

function defaultEnvContent(mysqlRootPassword: string): string {
  return [
    "# Bento stack environment (operator-owned, sensitive)",
    `MYSQL_ROOT_PASSWORD=${mysqlRootPassword}`,
    "REDIS_PASSWORD=",
    "TZ=UTC",
    "COMPOSE_PROJECT_NAME=bento",
    "",
  ].join("\n");
}
