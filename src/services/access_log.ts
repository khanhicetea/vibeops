/**
 * Opt-in per-app access logs: enable/disable, rotate+reopen, GoAccess report (F-23).
 * Enable/disable is nginx-only (no PHP/runner reload). Rotation uses reopen, not config reload.
 */

import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
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
  /** Attach opens GoAccess's terminal dashboard; otherwise an HTML report is written. */
  attach: boolean;
  /** One-shot container; no permanent analytics service. */
  command: string[];
  dryRun: boolean;
};

export type GoAccessReportOptions = {
  output?: string;
  dryRun?: boolean;
  /** Attach the one-shot container to the current terminal instead of writing HTML. */
  attach?: boolean;
};

/**
 * Plan a one-shot GoAccess HTML report or attached terminal dashboard.
 * Does not start a permanent analytics service (architecture §10).
 */
export function buildGoAccessReportPlan(
  platform: Platform,
  slug: string,
  opts?: GoAccessReportOptions,
): GoAccessReportPlan {
  const logPath = accessLogHostPath(platform, slug);
  const defaultReportDir = join(platform.paths.paths.logsDir, "reports");
  const requestedOutput = opts?.output ?? join(defaultReportDir, `${slug}-access.html`);
  const reportPath = isAbsolute(requestedOutput)
    ? requestedOutput
    : resolve(platform.paths.paths.root, requestedOutput);
  const reportDir = dirname(reportPath);
  const reportFile = basename(reportPath);
  const dryRun = opts?.dryRun ?? false;
  const attach = opts?.attach ?? false;

  // Log format matches bento_timed in nginx.conf.tpl. The final fields preserve
  // request/upstream timing while remaining compatible with GoAccess parsing.
  const goAccessArgs = [
    `/var/log/nginx/${slug}.access.log`,
    '--log-format=%h %^[%d:%t %^] "%r" %s %b "%R" "%u" rt=%T urt=%^',
    "--date-format=%d/%b/%Y",
    "--time-format=%H:%M:%S",
  ];
  const command = [
    "docker",
    "run",
    "--rm",
    ...(attach ? ["-it"] : []),
    "-v",
    `${join(platform.paths.paths.logsDir, "nginx")}:/var/log/nginx:ro`,
    ...(attach ? [] : ["-v", `${reportDir}:/report`]),
    "allinurl/goaccess:latest",
    ...goAccessArgs,
    ...(attach ? [] : ["-o", `/report/${reportFile}`]),
  ];

  return { slug, logPath, reportPath, attach, command, dryRun };
}

/** Generate HTML, or return a dry-run/attached plan for the CLI or TUI. */
export async function generateAccessReport(
  platform: Platform,
  state: DesiredState,
  slug: string,
  opts?: GoAccessReportOptions,
): Promise<GoAccessReportPlan & { code?: number; stdout?: string; stderr?: string }> {
  if (!state.apps[slug]) throw notFoundError(`app not found: ${slug}`);
  const plan = buildGoAccessReportPlan(platform, slug, opts);

  if (!(await platform.fs.exists(plan.logPath))) {
    throw validationError(
      `access log not found for ${slug}: ${plan.logPath}`,
      { recovery: "Enable logging and generate traffic, or pass an existing log path." },
    );
  }

  if (!plan.attach) await platform.fs.mkdirp(dirname(plan.reportPath), 0o755);

  // Attached mode must be started by the CLI/TUI with inherited stdio. The
  // platform runner intentionally captures output and would break GoAccess's UI.
  if (plan.dryRun || plan.attach) return plan;

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
