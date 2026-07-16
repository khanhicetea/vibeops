import { join, normalize, resolve } from "@std/path";
import type { PathPolicy, StackPaths } from "./interfaces.ts";
import { validationError } from "../domain/errors.ts";
import { APP_HOME_ROOT } from "../domain/types.ts";

export function resolveStackPaths(stackRoot: string): StackPaths {
  const root = resolve(stackRoot);
  const generatedDir = join(root, "generated");
  return {
    root,
    stateFile: join(root, "state.json"),
    envFile: join(root, ".env"),
    generatedDir,
    lockDir: join(root, "locks"),
    renderLock: join(root, "locks", "render.lock"),
    journalFile: join(root, "generated", ".render-journal.json"),
    stagingDir: join(root, "generated", ".staging"),
    composeDir: join(generatedDir, "compose"),
    nginxDir: join(generatedDir, "nginx"),
    phpDir: join(generatedDir, "php"),
    mysqlDir: join(generatedDir, "mysql"),
    runnerDir: join(generatedDir, "runner"),
    secretsDir: join(generatedDir, "secrets"),
    backupsDir: join(root, "backups"),
    certsDir: join(root, "certs"),
    customDir: join(root, "custom"),
    overlaysDir: join(root, "overlays"),
    homesDir: join(root, "homes"),
    assetCacheDir: join(root, ".asset-cache"),
    logsDir: join(root, "logs"),
  };
}

export function createPathPolicy(stackRoot: string): PathPolicy {
  const paths = resolveStackPaths(stackRoot);
  return {
    paths,
    assertInsideHome(home: string, workdir: string): string {
      const homeResolved = resolve(home);
      const workResolved = resolve(homeResolved, workdir);
      const prefix = homeResolved.endsWith("/") ? homeResolved : `${homeResolved}/`;
      if (workResolved !== homeResolved && !workResolved.startsWith(prefix)) {
        throw validationError(
          `working directory escapes app home: ${workdir}`,
          { home: homeResolved, workdir: workResolved },
        );
      }
      // Reject symlink escape is best-effort at call sites; path normalize check here.
      if (normalize(workResolved).includes("..")) {
        throw validationError(`working directory is unsafe: ${workdir}`);
      }
      return workResolved;
    },
    appHome(slug: string): string {
      // Host-side durable home under stack; containers map to /home/<slug>
      return join(paths.homesDir, slug);
    },
    appSocket(_phpService: string, slug: string): string {
      // Path as seen inside PHP-FPM container
      return `/run/php-fpm/${slug}.sock`;
    },
    hostSocket(phpService: string, slug: string): string {
      // Path as seen on host / nginx
      return join(paths.root, "runtime", "php-fpm", phpService, `${slug}.sock`);
    },
  };
}

export function containerAppHome(slug: string): string {
  return `${APP_HOME_ROOT}/${slug}`;
}
