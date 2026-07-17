/**
 * Managed PHP version lifecycle.
 */

import type { DesiredState, ManagedPhpVersion } from "../domain/state.ts";
import { phpImage, phpServiceName } from "../domain/state.ts";
import { asPhpVersion, PHP_GLOBAL_PROCESS_CAP } from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import { compareMajorMinor, parsePhpVersion, unwrap } from "../schemas/validators.ts";
import type { Platform } from "../platform/mod.ts";

export function addPhpVersion(
  state: DesiredState,
  versionInput: string,
  processCap = PHP_GLOBAL_PROCESS_CAP,
): DesiredState {
  const version = asPhpVersion(unwrap(parsePhpVersion(versionInput), "phpVersion"));
  if (state.phpVersions.some((v) => v.version === version)) {
    throw conflictError(`PHP version ${version} is already managed`);
  }
  const managed: ManagedPhpVersion = {
    version,
    service: phpServiceName(version),
    image: phpImage(version),
    processCap,
  };
  return {
    ...state,
    phpVersions: [...state.phpVersions, managed].sort((a, b) =>
      compareMajorMinor(a.version, b.version)
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function removePhpVersion(
  state: DesiredState,
  versionInput: string,
): DesiredState {
  const version = asPhpVersion(unwrap(parsePhpVersion(versionInput), "phpVersion"));
  const found = state.phpVersions.find((v) => v.version === version);
  if (!found) throw notFoundError(`PHP version ${version} is not managed`);

  if (state.phpVersions.length <= 1) {
    throw safetyError("refusing to remove the final managed PHP version");
  }
  if (state.defaults.phpVersion === version) {
    throw safetyError(
      `refusing to remove default PHP version ${version}`,
      "Change the stack default PHP version first.",
    );
  }
  const inUse = Object.values(state.apps).filter((a) => a.phpVersion === version);
  if (inUse.length > 0) {
    throw safetyError(
      `refusing to remove PHP ${version}: used by apps ${inUse.map((a) => a.slug).join(", ")}`,
    );
  }

  return {
    ...state,
    phpVersions: state.phpVersions.filter((v) => v.version !== version),
    updatedAt: new Date().toISOString(),
  };
}

export function listPhpVersions(state: DesiredState): ManagedPhpVersion[] {
  return [...state.phpVersions].sort((a, b) => compareMajorMinor(a.version, b.version));
}

/** Ephemeral PHP CLI execution plan (caller runs via docker compose run). */
export type CliExecPlan = {
  /** Compose service name, e.g. `php85-cli` (profile-gated). */
  service: string;
  /** Compose profile that enables the CLI service. */
  profile: "cli";
  user: string;
  workdir: string;
  env: Record<string, string>;
  argv: string[];
  /** App slug for operator messaging. */
  slug: string;
  /** PHP version selected for this invocation. */
  phpVersion: string;
};

/** Ephemeral CLI execution plan (caller runs via docker compose run --profile cli). */
export function buildCliExec(
  platform: Platform,
  state: DesiredState,
  slug: string,
  argv: string[],
  opts?: { workdir?: string; phpVersionOverride?: string },
): CliExecPlan {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);

  let phpVersion = app.phpVersion;
  if (opts?.phpVersionOverride) {
    const ov = asPhpVersion(
      unwrap(parsePhpVersion(opts.phpVersionOverride), "phpVersion"),
    );
    if (ov !== app.phpVersion) {
      // Spec: mismatched override fails before side effects when not intentional —
      // we allow explicit override only if the version is managed, but warn via throw if not managed.
      if (!state.phpVersions.some((v) => v.version === ov)) {
        throw validationError(`override PHP version ${ov} is not managed`);
      }
      phpVersion = ov;
    }
  }
  const managed = state.phpVersions.find((v) => v.version === phpVersion);
  if (!managed) throw validationError(`PHP version ${phpVersion} is not managed`);

  const workdir = platform.paths.assertInsideHome(
    app.home,
    opts?.workdir ?? app.home,
  );

  return {
    // Ephemeral CLI is a profile service: `${phpService}-cli` (see compose fragment).
    service: `${managed.service}-cli`,
    profile: "cli",
    // Numeric identity for operator display; entrypoint drops privs (no docker -u).
    user: `${app.uid}:${app.gid}`,
    workdir,
    env: {
      HOME: app.home,
      BENTO_APP: app.slug,
      BENTO_UID: String(app.uid),
      BENTO_GID: String(app.gid),
      USER: app.slug,
      LOGNAME: app.slug,
    },
    argv: argv.length ? argv : ["bash"],
    slug: app.slug,
    phpVersion: String(phpVersion),
  };
}

/**
 * Compose command args (after global `-f` options) for an ephemeral app CLI attach/run.
 * Container starts as root; entrypoint installs passwd name + setpriv-drops to app UID.
 * Use `-it` for interactive shells and `-T` for scripted non-TTY invocations.
 * Never pass docker `-u` here — that yields "I have no name!" with no passwd entry.
 */
export function cliRunComposeCommand(
  plan: CliExecPlan,
  opts?: { tty?: boolean },
): string[] {
  const tty = opts?.tty ?? true;
  return [
    "--profile",
    plan.profile,
    "run",
    "--rm",
    ...(tty ? ["-it"] : ["-T"]),
    "-w",
    plan.workdir,
    ...Object.entries(plan.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    plan.service,
    ...plan.argv,
  ];
}
