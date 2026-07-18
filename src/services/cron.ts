/**
 * Per-app scheduled jobs.
 */

import type { CronJob, DesiredState } from "../domain/state.ts";
import { asAppSlug, asCronJobName } from "../domain/types.ts";
import { conflictError, notFoundError, validationError } from "../domain/errors.ts";
import {
  parseAppSlug,
  parseCronSchedule,
  parseStringArray,
  unwrap,
} from "../schemas/validators.ts";
import type { Platform } from "../platform/mod.ts";
import {
  type ReloadPlan,
  reloadPlanForCronChange,
  reloadPlanForRunnerChange,
} from "../domain/reload.ts";

export type AddCronInput = {
  name: string;
  app: string;
  schedule: string;
  command: string[];
  commandMode?: "argv" | "shell";
  timezone?: string;
  workdir?: string;
  output?: "log" | "null" | "inherit";
  timeoutSec?: number;
  lock?: string;
};

export type EditCronInput = {
  app: string;
  name: string;
  schedule?: string;
  command?: string[];
  commandMode?: "argv" | "shell";
  timezone?: string;
  workdir?: string;
  output?: "log" | "null" | "inherit";
  timeoutSec?: number;
  lock?: string;
};

export function addCronJob(
  state: DesiredState,
  input: AddCronInput,
  platform: Platform,
): { state: DesiredState; job: CronJob; reloadPlan: ReloadPlan } {
  const appSlug = unwrap(parseAppSlug(input.app), "app");
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);

  const name = input.name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw validationError("cron job name must be alphanumeric/underscore/hyphen");
  }
  if (state.cronJobs.some((j) => j.app === appSlug && j.name === name)) {
    throw conflictError(`cron job ${name} already exists for app ${appSlug}`);
  }

  const schedule = unwrap(parseCronSchedule(input.schedule), "schedule");
  const command = unwrap(
    parseStringArray(input.command, "command"),
    "command",
  );
  if (command.length === 0) throw validationError("command must not be empty");
  const commandMode = input.commandMode ?? "argv";
  if (commandMode === "shell" && command.length !== 1) {
    throw validationError("shell command must be supplied as one unparsed string");
  }

  const workdir = platform.paths.assertInsideHome(
    app.home,
    input.workdir ?? app.home,
  );

  const job: CronJob = {
    name: asCronJobName(name),
    app: asAppSlug(appSlug),
    schedule,
    timezone: input.timezone ?? "UTC",
    workdir,
    command,
    commandMode,
    output: input.output ?? "log",
    enabled: true,
    ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
    ...(input.lock ? { lock: input.lock } : {}),
  };

  return {
    state: {
      ...state,
      cronJobs: [...state.cronJobs, job],
      updatedAt: platform.clock.nowIso(),
    },
    job,
    reloadPlan: reloadPlanForCronChange(`${app.phpService}-runner`, appSlug),
  };
}

export function editCronJob(
  state: DesiredState,
  input: EditCronInput,
  platform: Platform,
): { state: DesiredState; job: CronJob; reloadPlan: ReloadPlan } {
  const appSlug = unwrap(parseAppSlug(input.app), "app");
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);

  const index = state.cronJobs.findIndex((j) => j.app === appSlug && j.name === input.name);
  if (index < 0) {
    throw notFoundError(`cron job ${input.name} not found for app ${appSlug}`);
  }
  const current = state.cronJobs[index]!;

  const schedule = input.schedule === undefined
    ? current.schedule
    : unwrap(parseCronSchedule(input.schedule), "schedule");
  const command = input.command === undefined
    ? current.command
    : unwrap(parseStringArray(input.command, "command"), "command");
  if (command.length === 0) throw validationError("command must not be empty");
  const commandMode = input.commandMode ?? current.commandMode;
  if (commandMode === "shell" && command.length !== 1) {
    throw validationError("shell command must be supplied as one unparsed string");
  }

  const timezone = input.timezone === undefined ? current.timezone : input.timezone.trim();
  if (timezone.length === 0) throw validationError("timezone must not be empty");
  if (
    input.timeoutSec !== undefined &&
    (!Number.isInteger(input.timeoutSec) || input.timeoutSec <= 0)
  ) {
    throw validationError("timeout must be a positive integer");
  }

  const job: CronJob = {
    ...current,
    schedule,
    command,
    commandMode,
    timezone,
    workdir: input.workdir === undefined
      ? current.workdir
      : platform.paths.assertInsideHome(app.home, input.workdir),
    output: input.output ?? current.output,
    ...(input.timeoutSec !== undefined ? { timeoutSec: input.timeoutSec } : {}),
    ...(input.lock !== undefined ? { lock: input.lock } : {}),
  };
  const cronJobs = [...state.cronJobs];
  cronJobs[index] = job;

  return {
    state: { ...state, cronJobs, updatedAt: platform.clock.nowIso() },
    job,
    reloadPlan: reloadPlanForCronChange(`${app.phpService}-runner`, appSlug),
  };
}

export function removeCronJob(
  state: DesiredState,
  appSlug: string,
  name: string,
  now: string,
): { state: DesiredState; reloadPlan: ReloadPlan } {
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);
  const before = state.cronJobs.length;
  const cronJobs = state.cronJobs.filter((j) => !(j.app === appSlug && j.name === name));
  if (cronJobs.length === before) {
    throw notFoundError(`cron job ${name} not found for app ${appSlug}`);
  }
  const runnerService = `${app.phpService}-runner`;
  // If another schedule (or deploy drain) remains, Supervisor's program config
  // is unchanged and Supercronic itself must reread the mounted crontab. When
  // the final schedule is removed, supervisorctl update stops the program.
  const schedulerRemains = app.deploy.enabled ||
    cronJobs.some((j) => j.app === appSlug && j.enabled);
  return {
    state: { ...state, cronJobs, updatedAt: now },
    reloadPlan: schedulerRemains
      ? reloadPlanForCronChange(runnerService, appSlug)
      : reloadPlanForRunnerChange(runnerService),
  };
}

export function listCronJobs(state: DesiredState, appSlug?: string): CronJob[] {
  return state.cronJobs
    .filter((j) => !appSlug || j.app === appSlug)
    .sort((a, b) => `${a.app}:${a.name}`.localeCompare(`${b.app}:${b.name}`));
}
