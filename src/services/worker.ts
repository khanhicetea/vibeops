/**
 * Long-running workers supervised as flat s6 services.
 */

import type { DesiredState, Worker } from "../domain/state.ts";
import { asAppSlug, asWorkerName } from "../domain/types.ts";
import { conflictError, notFoundError, validationError } from "../domain/errors.ts";
import { parseAppSlug, parseStringArray, unwrap } from "../schemas/validators.ts";
import type { Platform } from "../platform/mod.ts";
import { composeArgs } from "./compose.ts";
import { type ReloadPlan, reloadPlanForRunnerChange } from "../domain/reload.ts";

export type AddWorkerInput = {
  name: string;
  app: string;
  command: string[];
  workdir?: string;
  autorestart?: boolean;
  stopsignal?: string;
  stopwaitsecs?: number;
};

export function addWorker(
  state: DesiredState,
  input: AddWorkerInput,
  platform: Platform,
): { state: DesiredState; worker: Worker; reloadPlan: ReloadPlan } {
  const appSlug = unwrap(parseAppSlug(input.app), "app");
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);

  const name = input.name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw validationError("worker name must be alphanumeric/underscore/hyphen");
  }
  if (state.workers.some((w) => w.app === appSlug && w.name === name)) {
    throw conflictError(`worker ${name} already exists for app ${appSlug}`);
  }

  const command = unwrap(parseStringArray(input.command, "command"), "command");
  if (command.length === 0) throw validationError("command must not be empty");

  const workdir = platform.paths.assertInsideHome(
    app.home,
    input.workdir ?? `${app.home}/code`,
  );

  const worker: Worker = {
    name: asWorkerName(name),
    app: asAppSlug(appSlug),
    command,
    workdir,
    enabled: true,
    autorestart: input.autorestart ?? true,
    stopsignal: input.stopsignal ?? "TERM",
    stopwaitsecs: input.stopwaitsecs ?? 10,
  };

  return {
    state: {
      ...state,
      workers: [...state.workers, worker],
      updatedAt: platform.clock.nowIso(),
    },
    worker,
    reloadPlan: reloadPlanForRunnerChange(`${app.phpService}-runner`),
  };
}

export function removeWorker(
  state: DesiredState,
  appSlug: string,
  name: string,
  now: string,
): { state: DesiredState; reloadPlan: ReloadPlan } {
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);
  const before = state.workers.length;
  const workers = state.workers.filter((w) => !(w.app === appSlug && w.name === name));
  if (workers.length === before) {
    throw notFoundError(`worker ${name} not found for app ${appSlug}`);
  }
  return {
    state: { ...state, workers, updatedAt: now },
    reloadPlan: reloadPlanForRunnerChange(`${app.phpService}-runner`),
  };
}

export function listWorkers(state: DesiredState, appSlug?: string): Worker[] {
  return state.workers
    .filter((w) => !appSlug || w.app === appSlug)
    .sort((a, b) => `${a.app}:${a.name}`.localeCompare(`${b.app}:${b.name}`));
}

/** s6 service name for a worker (flat — independent restart). */
export function workerProgramName(appSlug: string, workerName: string): string {
  return `worker-${appSlug}-${workerName}`;
}

/** Runner compose service for the app's PHP version. */
export function workerRunnerService(app: { phpService: string }): string {
  return `${app.phpService}-runner`;
}

export type WorkerControlAction = "start" | "stop" | "restart" | "status" | "signal";

export type WorkerControlPlan = {
  app: string;
  name: string;
  program: string;
  runnerService: string;
  action: WorkerControlAction;
  signal?: string;
  /** Compose arguments after `docker compose`; used to assemble all -f files. */
  composeCommand: string[];
  /** Inspectable shorthand argv for diagnostics and scoped-command tests. */
  command: string[];
  desiredState: DesiredState;
};

/**
 * Build an s6 plan that controls exactly one flat worker service.
 * Changing one worker must not restart siblings or unrelated schedulers (F-15).
 */
export function buildWorkerControlPlan(
  state: DesiredState,
  appSlug: string,
  name: string,
  action: WorkerControlAction,
): WorkerControlPlan {
  const app = state.apps[appSlug];
  if (!app) throw notFoundError(`app not found: ${appSlug}`);
  const worker = state.workers.find((w) => w.app === appSlug && w.name === name);
  if (!worker) throw notFoundError(`worker ${name} not found for app ${appSlug}`);

  const program = workerProgramName(appSlug, name);
  const runnerService = workerRunnerService(app);
  if (action === "signal") {
    throw validationError("use buildWorkerSignalPlan for signal actions");
  }
  const servicePath = `/run/bento-s6/services/${program}`;
  const composeCommand = action === "status"
    ? ["exec", "-T", runnerService, "/command/s6-svstat", servicePath]
    : [
      "exec",
      "-T",
      runnerService,
      "/command/s6-svc",
      action === "start" ? "-u" : action === "stop" ? "-d" : "-r",
      servicePath,
    ];
  const command = ["docker", "compose", ...composeCommand];

  return {
    app: appSlug,
    name,
    program,
    runnerService,
    action,
    composeCommand,
    command,
    desiredState: state,
  };
}

/** Build a scoped signal command for one worker service. */
export function buildWorkerSignalPlan(
  state: DesiredState,
  appSlug: string,
  name: string,
  signal: string,
): WorkerControlPlan {
  const base = buildWorkerControlPlan(state, appSlug, name, "status");
  const normalized = signal.trim().toUpperCase().replace(/^SIG/, "");
  const flags: Record<string, string> = {
    HUP: "-h",
    ALRM: "-a",
    INT: "-i",
    QUIT: "-q",
    USR1: "-1",
    USR2: "-2",
    TERM: "-t",
    KILL: "-k",
  };
  const flag = flags[normalized];
  if (!flag) {
    throw validationError(
      "signal must be one of HUP, ALRM, INT, QUIT, USR1, USR2, TERM, KILL",
    );
  }
  const composeCommand = [
    "exec",
    "-T",
    base.runnerService,
    "/command/s6-svc",
    flag,
    `/run/bento-s6/services/${base.program}`,
  ];
  return {
    ...base,
    action: "signal",
    signal: normalized,
    composeCommand,
    command: ["docker", "compose", ...composeCommand],
  };
}

/** Execute a worker control plan via the platform process runner. */
export async function controlWorker(
  platform: Platform,
  plan: WorkerControlPlan,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = await composeArgs(platform, plan.desiredState, plan.composeCommand);
  const result = await platform.process.run(command, {
    cwd: platform.paths.paths.root,
    timeoutMs: 30_000,
  });
  return result;
}

/**
 * Inspect a worker: s6 status for its service only.
 */
export async function inspectWorker(
  platform: Platform,
  state: DesiredState,
  appSlug: string,
  name: string,
): Promise<{
  plan: WorkerControlPlan;
  stdout: string;
  stderr: string;
  code: number;
  worker: Worker;
}> {
  const worker = state.workers.find((w) => w.app === appSlug && w.name === name);
  if (!worker) throw notFoundError(`worker ${name} not found for app ${appSlug}`);
  const plan = buildWorkerControlPlan(state, appSlug, name, "status");
  const result = await controlWorker(platform, plan);
  return { plan, worker, ...result };
}

/** True when a command list targets only the given program (no sibling names). */
export function isScopedWorkerCommand(
  command: string[],
  program: string,
  siblingPrograms: string[],
): boolean {
  const joined = command.join(" ");
  if (!command.some((arg) => arg === program || arg.endsWith(`/${program}`))) return false;
  if (!command.some((arg) => arg.endsWith("/s6-svc") || arg.endsWith("/s6-svstat"))) {
    return false;
  }
  for (const sibling of siblingPrograms) {
    if (sibling !== program && joined.includes(sibling)) return false;
  }
  return true;
}
