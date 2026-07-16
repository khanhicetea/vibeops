/**
 * Managed PHP version lifecycle.
 */

import type { DesiredState, ManagedPhpVersion } from "../domain/state.ts";
import { phpImage, phpServiceName } from "../domain/state.ts";
import { asPhpVersion, PHP_GLOBAL_PROCESS_CAP } from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import { parsePhpVersion, unwrap } from "../schemas/validators.ts";
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
    phpVersions: [...state.phpVersions, managed].sort((a, b) => a.version.localeCompare(b.version)),
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
  return [...state.phpVersions].sort((a, b) => a.version.localeCompare(b.version));
}

/** Ephemeral CLI execution plan (caller runs via docker compose run). */
export function buildCliExec(
  platform: Platform,
  state: DesiredState,
  slug: string,
  argv: string[],
  opts?: { workdir?: string; phpVersionOverride?: string },
): { service: string; user: string; workdir: string; env: Record<string, string>; argv: string[] } {
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
    service: managed.service,
    user: `${app.uid}:${app.gid}`,
    workdir,
    env: {
      HOME: app.home,
      BENTO_APP: app.slug,
      USER: app.slug,
    },
    argv: argv.length ? argv : ["bash"],
  };
}
