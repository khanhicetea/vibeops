/**
 * Staged, serialized, recoverable render/apply transaction.
 *
 * lock -> stage -> promote -> validate -> reload -> finalize
 */

import { join, relative } from "@std/path";
import type { DesiredState } from "../domain/state.ts";
import type { ReloadPlan } from "../domain/reload.ts";
import { describeReloadPlan, emptyReloadPlan, reloadPlanIsEmpty } from "../domain/reload.ts";
import type { Platform } from "../platform/mod.ts";
import { platformError, renderError } from "../domain/errors.ts";
import { ASSET_VERSION } from "../version.ts";
import { generateAll } from "./generate.ts";
import { materializeDockerAssets } from "./assets_materialize.ts";

export type GeneratedFile = {
  /** Path relative to generatedDir */
  relPath: string;
  content: string | Uint8Array;
  mode: number;
  managed: boolean;
};

export type RenderResult = {
  files: GeneratedFile[];
  reloadPlan: ReloadPlan;
  assetDigest: string;
  managedManifest: string[];
};

export type ApplyOptions = {
  /** If true, promote files but do not signal services. */
  renderOnly?: boolean;
  /** Override reload plan; default uses full apply plan from generator. */
  reloadPlan?: ReloadPlan;
  /** Skip service validation (tests). */
  skipValidate?: boolean;
  /** Injected validators for tests. */
  validators?: ServiceValidator[];
  /** Injected reloader for tests. */
  reloader?: ServiceReloader;
  /** Caller already holds the exclusive render lock. */
  alreadyLocked?: boolean;
};

export type ServiceValidator = {
  name: string;
  validate: () => Promise<void>;
};

export type ServiceReloader = {
  reload: (plan: ReloadPlan) => Promise<void>;
};

type JournalEntry = {
  path: string;
  existed: boolean;
  mode?: number;
  backupRel?: string;
};

type RenderJournal = {
  version: 1;
  phase: "promoting" | "validating" | "reloading" | "finalizing";
  startedAt: string;
  assetVersion: string;
  entries: JournalEntry[];
  promoted: string[];
  staleToRemove: string[];
  reloadPlan: {
    nginx: boolean;
    phpFpm: string[];
    phpRunner: string[];
  };
};

const MANAGED_MARKER = "# bento-managed: true\n";
const MANAGED_MARKER_HASH = "# bento-managed: true\n";

export function withManagedMarker(content: string, style: "hash" | "none" = "hash"): string {
  if (style === "none") return content;
  if (content.startsWith(MANAGED_MARKER) || content.startsWith(MANAGED_MARKER_HASH)) {
    return content;
  }
  return `${MANAGED_MARKER_HASH}${content}`;
}

export class RenderService {
  constructor(private readonly platform: Platform) {}

  /** Render complete candidate without touching live generation. */
  async renderCandidate(state: DesiredState): Promise<RenderResult> {
    const assetDigest = await this.platform.assets.digest();
    const generated = await generateAll(this.platform, state, assetDigest);
    const managedManifest = generated
      .filter((f) => f.managed)
      .map((f) => f.relPath)
      .sort();
    return {
      files: generated,
      reloadPlan: generatedReloadPlan(state),
      assetDigest,
      managedManifest,
    };
  }

  /**
   * Full transaction: lock -> recover -> stage -> promote -> validate -> reload -> finalize
   */
  async apply(state: DesiredState, options: ApplyOptions = {}): Promise<RenderResult> {
    const release = options.alreadyLocked
      ? async () => {}
      : await this.platform.lock.exclusive(this.platform.paths.paths.renderLock);
    try {
      await this.recoverAbandoned();
      // Materialize docker build contexts + helpers for Compose (outside generated/)
      await materializeDockerAssets(
        this.platform,
        state.phpVersions.map((v) => String(v.version)),
      );
      const candidate = await this.renderCandidate(state);
      const reloadPlan = options.reloadPlan ?? candidate.reloadPlan;

      // Stage into same-filesystem staging directory
      const staging = this.platform.paths.paths.stagingDir;
      await this.platform.fs.remove(staging, { recursive: true });
      await this.platform.fs.mkdirp(staging);

      for (const file of candidate.files) {
        const dest = join(staging, file.relPath);
        const content = typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content;
        await this.platform.fs.writeBytes(dest, content, file.mode);
      }

      // Build journal and promote
      const liveRoot = this.platform.paths.paths.generatedDir;
      const backupRoot = join(liveRoot, ".transaction-backup");
      await this.platform.fs.remove(backupRoot, { recursive: true });
      await this.platform.fs.mkdirp(backupRoot);

      const existingManaged = await this.listManagedFiles(liveRoot);
      const desiredSet = new Set(candidate.managedManifest);
      const staleToRemove = existingManaged.filter((p) => !desiredSet.has(p));

      const journal: RenderJournal = {
        version: 1,
        phase: "promoting",
        startedAt: this.platform.clock.nowIso(),
        assetVersion: ASSET_VERSION,
        entries: [],
        promoted: [],
        staleToRemove,
        reloadPlan: {
          nginx: reloadPlan.nginx,
          phpFpm: [...reloadPlan.phpFpm],
          phpRunner: [...reloadPlan.phpRunner],
        },
      };

      await this.writeJournal(journal);

      try {
        for (const file of candidate.files) {
          const livePath = join(liveRoot, file.relPath);
          const stagePath = join(staging, file.relPath);
          const existed = await this.platform.fs.exists(livePath);
          const entry: JournalEntry = { path: file.relPath, existed };

          if (existed) {
            const st = await this.platform.fs.stat(livePath);
            entry.mode = st.mode;
            const backupRel = file.relPath;
            entry.backupRel = backupRel;
            const backupPath = join(backupRoot, backupRel);
            await this.platform.fs.mkdirp(join(backupPath, ".."));
            // copy bytes
            const bytes = await this.platform.fs.readBytes(livePath);
            await this.platform.fs.writeBytes(backupPath, bytes, st.mode & 0o777);
          }

          journal.entries.push(entry);
          await this.writeJournal(journal);

          // Atomic promote: rename from staging (same filesystem)
          await this.platform.fs.mkdirp(join(livePath, ".."));
          // write via temp in destination dir then rename for same-fs atomicity
          const bytes = await this.platform.fs.readBytes(stagePath);
          await this.platform.fs.atomicWriteBytes(livePath, bytes, file.mode);
          journal.promoted.push(file.relPath);
          await this.writeJournal(journal);
        }

        // Remove stale managed files only after full promotion
        for (const stale of staleToRemove) {
          const p = join(liveRoot, stale);
          if (await this.platform.fs.exists(p)) {
            // backup before remove
            const backupPath = join(backupRoot, stale);
            try {
              const bytes = await this.platform.fs.readBytes(p);
              const st = await this.platform.fs.stat(p);
              await this.platform.fs.writeBytes(backupPath, bytes, st.mode & 0o777);
              journal.entries.push({
                path: stale,
                existed: true,
                mode: st.mode,
                backupRel: stale,
              });
            } catch {
              // ignore backup failure for stale
            }
            await this.platform.fs.remove(p);
          }
        }
        await this.writeJournal(journal);

        // Validate
        journal.phase = "validating";
        await this.writeJournal(journal);

        if (!options.skipValidate) {
          const validators = options.validators ??
            defaultValidators(this.platform, reloadPlan);
          try {
            for (const v of validators) {
              await v.validate();
            }
          } catch (cause) {
            await this.rollbackFromJournal(journal, backupRoot);
            await this.clearJournal();
            throw renderError(
              `validation failed; previous generation restored: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            );
          }
        }

        // Reload (unless render-only)
        if (!options.renderOnly && !reloadPlanIsEmpty(reloadPlan)) {
          journal.phase = "reloading";
          await this.writeJournal(journal);
          const reloader = options.reloader ?? defaultReloader(this.platform);
          try {
            await reloader.reload(reloadPlan);
          } catch (cause) {
            // Validated new generation stays live; signal is retryable
            journal.phase = "finalizing";
            await this.writeJournal(journal);
            await this.clearJournal();
            await this.platform.fs.remove(backupRoot, { recursive: true });
            await this.platform.fs.remove(staging, { recursive: true });
            throw renderError(
              `reload signal failed after successful validation (new generation kept live; retry signal): ${
                cause instanceof Error ? cause.message : String(cause)
              }. targets=${describeReloadPlan(reloadPlan).join(",")}`,
              cause,
            );
          }
        }

        journal.phase = "finalizing";
        await this.writeJournal(journal);
        await this.clearJournal();
        await this.platform.fs.remove(backupRoot, { recursive: true });
        await this.platform.fs.remove(staging, { recursive: true });

        // Write generation metadata
        await this.platform.fs.atomicWriteText(
          join(liveRoot, ".generation.json"),
          `${
            JSON.stringify(
              {
                assetVersion: ASSET_VERSION,
                assetDigest: candidate.assetDigest,
                renderedAt: this.platform.clock.nowIso(),
                managedFiles: candidate.managedManifest,
              },
              null,
              2,
            )
          }\n`,
          0o644,
        );

        return candidate;
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes("validation failed")) {
          throw cause;
        }
        if (cause instanceof Error && cause.message.includes("reload signal failed")) {
          throw cause;
        }
        // Promotion failure: restore
        try {
          await this.rollbackFromJournal(journal, backupRoot);
        } catch {
          // best effort
        }
        await this.clearJournal();
        throw renderError(
          `render/apply failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        );
      }
    } finally {
      await release();
    }
  }

  /** Detect and recover abandoned mid-promotion transactions. */
  async recoverAbandoned(): Promise<"none" | "restored"> {
    const journalPath = this.platform.paths.paths.journalFile;
    if (!(await this.platform.fs.exists(journalPath))) return "none";
    const text = await this.platform.fs.readText(journalPath);
    let journal: RenderJournal;
    try {
      journal = JSON.parse(text) as RenderJournal;
    } catch {
      await this.clearJournal();
      return "none";
    }
    const backupRoot = join(this.platform.paths.paths.generatedDir, ".transaction-backup");
    if (journal.phase === "promoting" || journal.phase === "validating") {
      await this.rollbackFromJournal(journal, backupRoot);
      await this.clearJournal();
      return "restored";
    }
    // reloading/finalizing: keep new generation
    await this.clearJournal();
    try {
      await this.platform.fs.remove(backupRoot, { recursive: true });
    } catch {
      // ignore
    }
    return "none";
  }

  private async writeJournal(journal: RenderJournal): Promise<void> {
    await this.platform.fs.atomicWriteText(
      this.platform.paths.paths.journalFile,
      `${JSON.stringify(journal, null, 2)}\n`,
      0o600,
    );
  }

  private async clearJournal(): Promise<void> {
    await this.platform.fs.remove(this.platform.paths.paths.journalFile);
  }

  private async rollbackFromJournal(
    journal: RenderJournal,
    backupRoot: string,
  ): Promise<void> {
    const liveRoot = this.platform.paths.paths.generatedDir;
    // Restore in reverse order
    for (const entry of [...journal.entries].reverse()) {
      const livePath = join(liveRoot, entry.path);
      if (!entry.existed) {
        if (await this.platform.fs.exists(livePath)) {
          await this.platform.fs.remove(livePath);
        }
        continue;
      }
      if (entry.backupRel) {
        const backupPath = join(backupRoot, entry.backupRel);
        if (await this.platform.fs.exists(backupPath)) {
          const bytes = await this.platform.fs.readBytes(backupPath);
          await this.platform.fs.atomicWriteBytes(
            livePath,
            bytes,
            entry.mode !== undefined ? entry.mode & 0o777 : 0o644,
          );
        }
      }
    }
  }

  private async listManagedFiles(liveRoot: string): Promise<string[]> {
    const result: string[] = [];
    const skip = new Set([
      ".staging",
      ".transaction-backup",
      ".render-journal.json",
      ".generation.json",
    ]);

    const walk = async (dir: string, prefix: string) => {
      if (!(await this.platform.fs.exists(dir))) return;
      let names: string[];
      try {
        names = await this.platform.fs.readDir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!prefix && skip.has(name)) continue;
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        try {
          const st = await this.platform.fs.stat(full);
          if (st.isDirectory) await walk(full, rel);
          else if (st.isFile) {
            // Consider managed if marked or under known managed trees
            let managed = rel.startsWith("compose/") ||
              rel.startsWith("nginx/") ||
              rel.startsWith("php/") ||
              rel.startsWith("mysql/") ||
              rel.startsWith("runner/") ||
              rel.startsWith("secrets/");
            if (!managed) {
              try {
                const head = await this.platform.fs.readText(full);
                if (head.startsWith("# bento-managed:")) managed = true;
              } catch {
                // binary
              }
            }
            if (managed) result.push(rel);
          }
        } catch {
          // ignore
        }
      }
    };

    await walk(liveRoot, "");
    return result.sort();
  }
}

function generatedReloadPlan(state: DesiredState): ReloadPlan {
  const plan = emptyReloadPlan();
  plan.nginx = true;
  for (const v of state.phpVersions) {
    plan.phpFpm.add(v.service);
    plan.phpRunner.add(`${v.service}-runner`);
  }
  return plan;
}

function isDockerUnavailable(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("cannot connect") ||
    t.includes("no such file") ||
    t.includes("no such container") ||
    t.includes("not running") ||
    t.includes("is not running") ||
    t.includes("no container") ||
    t.includes("permission denied") ||
    t.includes("connect: no such file") ||
    t.includes("cannot find") ||
    t.includes("error response from daemon") ||
    t.includes("docker desktop") ||
    t.includes("skipped") ||
    t.includes("timed out") ||
    t.includes("signal: killed") ||
    t.includes("exit status 124") ||
    t.includes("failed to run")
  );
}

function defaultValidators(
  platform: Platform,
  plan: ReloadPlan,
): ServiceValidator[] {
  const validators: ServiceValidator[] = [];
  // Config-file syntax checks when docker/nginx/php tools available; soft by default.
  if (plan.nginx) {
    validators.push({
      name: "nginx",
      validate: async () => {
        const result = await platform.process.run(
          ["docker", "compose", "exec", "-T", "nginx", "nginx", "-t"],
          { cwd: platform.paths.paths.root, timeoutMs: 3_000 },
        ).catch(() => ({ code: 0, stdout: "", stderr: "skipped" }));
        const detail = `${result.stderr}\n${result.stdout}`;
        if (result.code !== 0 && !isDockerUnavailable(detail)) {
          throw platformError(`nginx validation failed: ${result.stderr || result.stdout}`);
        }
      },
    });
  }
  return validators;
}

function defaultReloader(platform: Platform): ServiceReloader {
  return {
    reload: async (plan: ReloadPlan) => {
      const root = platform.paths.paths.root;
      const soft = async (command: string[]) => {
        const r = await platform.process.run(command, {
          cwd: root,
          timeoutMs: 3_000,
        }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
        return r;
      };

      if (plan.nginx) {
        const r = await soft([
          "docker",
          "compose",
          "exec",
          "-T",
          "nginx",
          "nginx",
          "-s",
          "reload",
        ]);
        const detail = `${r.stderr}\n${r.stdout}`;
        // Stopped/unavailable services are not fatal; config is ready for next start.
        if (r.code !== 0 && !isDockerUnavailable(detail) && r.code !== 124) {
          throw platformError(`nginx reload failed: ${r.stderr || r.stdout}`);
        }
      }
      for (const svc of plan.phpFpm) {
        await soft(["docker", "compose", "exec", "-T", svc, "kill", "-USR2", "1"]);
      }
      for (const svc of plan.phpRunner) {
        await soft([
          "docker",
          "compose",
          "exec",
          "-T",
          svc,
          "supervisorctl",
          "reread",
        ]);
        await soft([
          "docker",
          "compose",
          "exec",
          "-T",
          svc,
          "supervisorctl",
          "update",
        ]);
      }
    },
  };
}

export function relativeGenerated(
  generatedDir: string,
  absolutePath: string,
): string {
  return relative(generatedDir, absolutePath);
}
