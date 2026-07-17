/**
 * Opt-in per-app access logs: enable/disable, rotate+reopen, GoAccess report (F-23).
 * Enable/disable is nginx-only (no PHP/runner reload). Rotation uses reopen, not config reload.
 */

import { join } from "@std/path";
import type { DesiredState } from "../domain/state.ts";
import { notFoundError, serviceError, validationError } from "../domain/errors.ts";
import type { ReloadPlan } from "../domain/reload.ts";
import { reloadPlanForDomainChange } from "../domain/reload.ts";
import type { Platform } from "../platform/mod.ts";

export type AccessLogMutation = {
  state: DesiredState;
  reloadPlan: ReloadPlan;
  enabled: boolean;
  /** Existing log files are never deleted on disable. */
  preservedLogPath: string;
};

/** Host-side path for an app access log (nginx container bind-mounts logs). */
export function accessLogHostPath(platform: Platform, slug: string): string {
  return join(platform.paths.paths.logsDir, "nginx", `${slug}.access.log`);
}

/** Container path used in generated vhosts. */
export function accessLogContainerPath(slug: string): string {
  return `/var/log/nginx/${slug}.access.log`;
}

/**
 * Enable or disable per-app access logs.
 * Returns an nginx-only reload plan (F-23: no PHP/runner reload).
 * Disabling preserves existing log files on disk.
 */
export function setAppAccessLog(
  state: DesiredState,
  slug: string,
  enabled: boolean,
  now: string,
  platform: Platform,
): AccessLogMutation {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);

  const nextApp = { ...app, accessLog: enabled, updatedAt: now };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: nextApp },
      updatedAt: now,
    },
    reloadPlan: reloadPlanForDomainChange(), // nginx only
    enabled,
    preservedLogPath: accessLogHostPath(platform, slug),
  };
}

export type RotatePlan = {
  slug: string;
  logPath: string;
  rotatedPath: string;
  /** Host-side rotate steps (rename). */
  hostRename: { from: string; to: string };
  /** nginx reopen signal — not a full config reload. */
  reopenCommand: string[];
};

/**
 * Plan access-log rotation under live traffic:
 * rename current log, then `nginx -s reopen` (not config reload).
 */
export function buildAccessLogRotatePlan(
  platform: Platform,
  slug: string,
  stamp: string,
): RotatePlan {
  const logPath = accessLogHostPath(platform, slug);
  const rotatedPath = `${logPath}.${stamp}`;
  return {
    slug,
    logPath,
    rotatedPath,
    hostRename: { from: logPath, to: rotatedPath },
    reopenCommand: [
      "docker",
      "compose",
      "exec",
      "-T",
      "nginx",
      "nginx",
      "-s",
      "reopen",
    ],
  };
}

/** Execute rotation: rename if present, then reopen nginx log files. */
export async function rotateAccessLog(
  platform: Platform,
  state: DesiredState,
  slug: string,
): Promise<{ plan: RotatePlan; rotated: boolean; reopened: boolean }> {
  if (!state.apps[slug]) throw notFoundError(`app not found: ${slug}`);
  const stamp = platform.clock.nowIso().replace(/[:.]/g, "-");
  const plan = buildAccessLogRotatePlan(platform, slug, stamp);

  let rotated = false;
  if (await platform.fs.exists(plan.logPath)) {
    await platform.fs.rename(plan.hostRename.from, plan.hostRename.to);
    rotated = true;
  }

  // Ensure log directory exists so reopen can recreate the file.
  await platform.fs.mkdirp(join(platform.paths.paths.logsDir, "nginx"), 0o755);

  const result = await platform.process.run(plan.reopenCommand, {
    cwd: platform.paths.paths.root,
    timeoutMs: 10_000,
  });
  // Soft-fail when docker/nginx unavailable (config ready for next start).
  const reopened = result.code === 0;
  if (!reopened) {
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (
      !detail.includes("cannot connect") &&
      !detail.includes("no such") &&
      !detail.includes("not running") &&
      !detail.includes("permission denied") &&
      !detail.includes("failed to run")
    ) {
      throw serviceError(
        `nginx reopen failed: ${(result.stderr || result.stdout || "unknown").trim()}`,
        "Access log may have been renamed; retry `bento logs access rotate` when nginx is up.",
      );
    }
  }

  return { plan, rotated, reopened };
}

export type GoAccessReportPlan = {
  slug: string;
  logPath: string;
  reportPath: string;
  /** One-shot container; no permanent analytics service. */
  command: string[];
  dryRun: boolean;
};

/**
 * Plan a one-shot GoAccess HTML report from the app access log.
 * Does not start a permanent analytics service (architecture §10).
 */
export function buildGoAccessReportPlan(
  platform: Platform,
  slug: string,
  opts?: { output?: string; dryRun?: boolean },
): GoAccessReportPlan {
  const logPath = accessLogHostPath(platform, slug);
  const reportDir = join(platform.paths.paths.logsDir, "reports");
  const reportPath = opts?.output ?? join(reportDir, `${slug}-access.html`);
  const dryRun = opts?.dryRun ?? false;

  // Mount stack logs read-only; write report to reports dir.
  // Log format matches bento_timed in nginx.conf.tpl.
  const command = [
    "docker",
    "run",
    "--rm",
    "-v",
    `${join(platform.paths.paths.logsDir, "nginx")}:/var/log/nginx:ro`,
    "-v",
    `${reportDir}:/report`,
    "allinurl/goaccess:latest",
    "/var/log/nginx/" + `${slug}.access.log`,
    "-o",
    `/report/${slug}-access.html`,
    "--log-format=COMBINED",
    "--date-format=%d/%b/%Y",
    "--time-format=%H:%M:%S",
  ];

  return { slug, logPath, reportPath, command, dryRun };
}

/** Run GoAccess report generation (or return the dry-run plan). */
export async function generateAccessReport(
  platform: Platform,
  state: DesiredState,
  slug: string,
  opts?: { output?: string; dryRun?: boolean },
): Promise<GoAccessReportPlan & { code?: number; stdout?: string; stderr?: string }> {
  if (!state.apps[slug]) throw notFoundError(`app not found: ${slug}`);
  const plan = buildGoAccessReportPlan(platform, slug, opts);

  if (!(await platform.fs.exists(plan.logPath))) {
    throw validationError(
      `access log not found for ${slug}: ${plan.logPath}`,
      { recovery: "Enable logging and generate traffic, or pass an existing log path." },
    );
  }

  await platform.fs.mkdirp(join(platform.paths.paths.logsDir, "reports"), 0o755);

  if (plan.dryRun) return plan;

  const result = await platform.process.run(plan.command, {
    cwd: platform.paths.paths.root,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw serviceError(
      `GoAccess report failed: ${(result.stderr || result.stdout || "unknown").trim()}`,
      "Ensure Docker can pull allinurl/goaccess and the access log is readable.",
    );
  }
  return { ...plan, code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** True when a reload plan is nginx-only (no PHP/runner). */
export function isNginxOnlyReloadPlan(plan: ReloadPlan): boolean {
  return plan.nginx === true && plan.phpFpm.size === 0 && plan.phpRunner.size === 0;
}
