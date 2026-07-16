/**
 * Long-running workers supervised as flat Supervisor programs.
 */

import type { DesiredState, Worker } from "../domain/state.ts";
import { asAppSlug, asWorkerName } from "../domain/types.ts";
import { conflictError, notFoundError, validationError } from "../domain/errors.ts";
import { parseAppSlug, parseStringArray, unwrap } from "../schemas/validators.ts";
import type { Platform } from "../platform/mod.ts";
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
    input.workdir ?? app.home,
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

/** Supervisor program name for a worker (flat — independent restart). */
export function workerProgramName(appSlug: string, workerName: string): string {
  return `worker-${appSlug}-${workerName}`;
}
