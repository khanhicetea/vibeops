/**
 * Load/save desired state with exclusive locking and atomic writes.
 *
 * Load is read-only: a no-op schema match never rewrites state.json (key order / defaults
 * stay as the operator left them). When a migration is required, load migrates in memory
 * only; callers that need to persist must use loadAndMigrate which backs up then saves.
 */

import { join } from "@std/path";
import type { DesiredState } from "../domain/state.ts";
import { createEmptyState } from "../domain/state.ts";
import { loadStateFromJson, stateToJson } from "../schemas/state.ts";
import { migrateStateDocument, migrationBackupName } from "../schemas/migrations.ts";
import type { Platform } from "../platform/mod.ts";
import { stateError } from "../domain/errors.ts";
import { STATE_SCHEMA_VERSION } from "../version.ts";

export class StateStore {
  constructor(private readonly platform: Platform) {}

  async exists(): Promise<boolean> {
    return await this.platform.fs.exists(this.platform.paths.paths.stateFile);
  }

  /**
   * Read-only load. Does not write state.json even when a migration would apply
   * (in-memory migration only). Use loadAndMigrate to persist upgrades.
   */
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

  /**
   * Load and, when schemaVersion < current, backup the prior document then atomically
   * save the migrated state. Returns whether a migration was persisted.
   */
  async loadAndMigrate(): Promise<{ state: DesiredState; migrated: boolean }> {
    const path = this.platform.paths.paths.stateFile;
    if (!(await this.platform.fs.exists(path))) {
      throw stateError(`no desired state at ${path}`, {
        recovery: "Run `bento init` to create an empty state document.",
      });
    }
    const text = await this.platform.fs.readText(path);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw stateError(
        `state.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          recovery:
            "Fix state.json or restore from backup. Bento will not overwrite invalid state.",
        },
      );
    }
    const { migrated, fromVersion } = migrateStateDocument(raw);
    const state = loadStateFromJson(text);
    if (!migrated) {
      return { state, migrated: false };
    }
    // Backup prior document before write
    const backupDir = join(this.platform.paths.paths.root, "backups", "state");
    await this.platform.fs.mkdirp(backupDir, 0o700);
    const backupPath = join(
      backupDir,
      migrationBackupName(fromVersion, this.platform.clock.nowIso()),
    );
    await this.platform.fs.atomicWriteText(backupPath, text, 0o600);
    await this.save(state);
    return { state, migrated: true };
  }

  async save(state: DesiredState): Promise<void> {
    const path = this.platform.paths.paths.stateFile;
    const next = {
      ...state,
      schemaVersion: STATE_SCHEMA_VERSION,
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
        defaultEnvContent({
          mysqlRootPassword: this.platform.random.hex(24),
          redisPassword: this.platform.random.hex(24),
          projectName: "bento",
        }),
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

function defaultEnvContent(opts: {
  mysqlRootPassword: string;
  redisPassword: string;
  projectName: string;
}): string {
  return [
    "# Bento stack environment (operator-owned, sensitive)",
    `MYSQL_ROOT_PASSWORD=${opts.mysqlRootPassword}`,
    `REDIS_PASSWORD=${opts.redisPassword}`,
    "TZ=UTC",
    "# Enable HTTP/3/QUIC listeners and Alt-Svc headers in generated Nginx vhosts.",
    "HTTP3=false",
    `COMPOSE_PROJECT_NAME=${opts.projectName}`,
    "",
  ].join("\n");
}
