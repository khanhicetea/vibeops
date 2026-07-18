/**
 * Stack maintenance: on-demand log retention and host cron registration (product §6.10).
 * In-runner service logs are separate from host maintenance.
 */

import { join } from "@std/path";
import type { Platform } from "../platform/mod.ts";
import { validationError } from "../domain/errors.ts";

/** Marker lines wrapping the managed crontab fragment. */
export const CRON_BEGIN_MARKER = "# BEGIN BENTO MAINTENANCE";
export const CRON_END_MARKER = "# END BENTO MAINTENANCE";

export type MaintenanceOptions = {
  /** Delete rotated logs older than this many days (default 14). */
  retainDays?: number;
  /** Also prune GoAccess HTML reports older than retainDays. */
  pruneReports?: boolean;
};

export type MaintenanceResult = {
  removed: string[];
  retained: string[];
  notes: string[];
};

/**
 * On-demand stack maintenance: bounded retention of nginx access logs and reports.
 * Does not touch durable app homes, MySQL volumes, or desired state.
 */
export async function runStackMaintenance(
  platform: Platform,
  opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const retainDays = opts.retainDays ?? 14;
  if (!Number.isFinite(retainDays) || retainDays < 1) {
    throw validationError("retainDays must be a positive number");
  }
  const pruneReports = opts.pruneReports ?? true;
  const cutoff = platform.clock.now().getTime() - retainDays * 24 * 60 * 60 * 1000;

  const removed: string[] = [];
  const retained: string[] = [];
  const notes: string[] = [
    "In-runner s6 service logs are separate from host maintenance.",
  ];

  const nginxLogDir = join(platform.paths.paths.logsDir, "nginx");
  await pruneDir(platform, nginxLogDir, cutoff, removed, retained, {
    // Keep active (non-rotated) *.access.log files always.
    keepIf: (name) => name.endsWith(".access.log") && !name.includes(".access.log."),
  });

  if (pruneReports) {
    const reportDir = join(platform.paths.paths.logsDir, "reports");
    await pruneDir(platform, reportDir, cutoff, removed, retained);
  }

  // Stack-level docker/app log directory if present
  const stackLogs = platform.paths.paths.logsDir;
  if (await platform.fs.exists(stackLogs)) {
    // only prune known rotated patterns at top level
    const names = await platform.fs.readDir(stackLogs).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".gz") && !/\.\d{4}-\d{2}/.test(name)) continue;
      const full = join(stackLogs, name);
      const st = await platform.fs.stat(full).catch(() => null);
      if (!st?.isFile) continue;
      // mtime not available on all fs adapters — use name stamp or remove by pattern age via retain list
      retained.push(full);
    }
  }

  notes.push(
    `retention=${retainDays}d removed=${removed.length} retained_active=${retained.length}`,
  );
  return { removed, retained, notes };
}

async function pruneDir(
  platform: Platform,
  dir: string,
  cutoffMs: number,
  removed: string[],
  retained: string[],
  opts?: { keepIf?: (name: string) => boolean },
): Promise<void> {
  if (!(await platform.fs.exists(dir))) return;
  const names = await platform.fs.readDir(dir);
  for (const name of names) {
    const full = join(dir, name);
    const st = await platform.fs.stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory) continue;
    if (opts?.keepIf?.(name)) {
      retained.push(full);
      continue;
    }
    // Prefer timestamp embedded in rotated names; fall back to keeping unknown files.
    const stamp = extractStampMs(name);
    if (stamp !== undefined && stamp < cutoffMs) {
      await platform.fs.remove(full);
      removed.push(full);
    } else {
      retained.push(full);
    }
  }
}

/** Parse ISO-like stamps from rotated filenames (e.g. app.access.log.2026-07-16T12-00-00-000Z). */
export function extractStampMs(name: string): number | undefined {
  const m = name.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d+)?Z)/,
  );
  if (!m) return undefined;
  // Convert filename-safe stamp back toward ISO
  const raw = m[1]!;
  const iso = raw
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/, "T$1:$2:$3.$4Z")
    .replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

// ---------------------------------------------------------------------------
// Host crontab registration (preserve unrelated entries)
// ---------------------------------------------------------------------------

export type CrontabMergeResult = {
  crontab: string;
  changed: boolean;
  action: "installed" | "removed" | "unchanged";
};

/** Build the managed maintenance crontab fragment. */
export function maintenanceCronFragment(opts: {
  schedule?: string;
  bentoBin: string;
  stackRoot: string;
}): string {
  const schedule = opts.schedule ?? "15 3 * * *";
  const line = `${schedule} ${opts.bentoBin} --stack ${
    shellSingle(opts.stackRoot)
  } maintenance run >/dev/null 2>&1`;
  return `${CRON_BEGIN_MARKER}\n${line}\n${CRON_END_MARKER}\n`;
}

/**
 * Merge or remove the Bento maintenance block while preserving unrelated crontab entries.
 * Pure function — safe to unit-test with fixtures (no real root required).
 */
export function mergeCrontab(
  existing: string,
  opts:
    | { action: "install"; fragment: string }
    | { action: "remove" },
): CrontabMergeResult {
  const without = stripManagedBlock(existing);
  if (opts.action === "remove") {
    const crontab = normalizeCrontab(without);
    const changed = crontab !== normalizeCrontab(existing);
    return {
      crontab,
      changed,
      action: changed ? "removed" : "unchanged",
    };
  }

  const base = without.endsWith("\n") || without === "" ? without : `${without}\n`;
  const fragment = opts.fragment.endsWith("\n") ? opts.fragment : `${opts.fragment}\n`;
  const crontab = normalizeCrontab(base + fragment);
  const changed = crontab !== normalizeCrontab(existing);
  return {
    crontab,
    changed,
    action: changed ? "installed" : "unchanged",
  };
}

/** Remove the managed block (BEGIN/END markers) from a crontab body. */
export function stripManagedBlock(crontab: string): string {
  const lines = crontab.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === CRON_BEGIN_MARKER) {
      skipping = true;
      continue;
    }
    if (line.trim() === CRON_END_MARKER) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function normalizeCrontab(text: string): string {
  // Preserve internal blank lines; ensure trailing newline when non-empty.
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  return trimmed ? `${trimmed}\n` : "";
}

function shellSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read host crontab via `crontab -l` (best-effort; empty when none).
 */
export async function readHostCrontab(platform: Platform): Promise<string> {
  const result = await platform.process.run(["crontab", "-l"], {
    timeoutMs: 5_000,
  });
  // crontab -l exits 1 when empty for some implementations
  if (result.code !== 0) {
    const err = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (err.includes("no crontab") || result.stdout.trim() === "") return "";
    // still return stdout if any
  }
  return result.stdout;
}

/**
 * Install or remove the host maintenance cron entry.
 */
export async function registerHostMaintenance(
  platform: Platform,
  opts: {
    action: "install" | "remove";
    schedule?: string;
    bentoBin?: string;
    stackRoot?: string;
  },
): Promise<CrontabMergeResult> {
  const existing = await readHostCrontab(platform);
  const fragment = maintenanceCronFragment({
    schedule: opts.schedule,
    bentoBin: opts.bentoBin ?? "bento",
    stackRoot: opts.stackRoot ?? platform.paths.paths.root,
  });
  const merged = mergeCrontab(
    existing,
    opts.action === "install" ? { action: "install", fragment } : { action: "remove" },
  );
  if (merged.changed) {
    const result = await platform.process.run(["crontab", "-"], {
      stdin: merged.crontab,
      timeoutMs: 5_000,
    });
    if (result.code !== 0) {
      throw validationError(
        `failed to update host crontab: ${(result.stderr || result.stdout || "unknown").trim()}`,
        {
          recovery: "Run as a user allowed to edit crontab, or paste the fragment manually.",
        },
      );
    }
  }
  return merged;
}
