/**
 * Compose assembly: base + managed version fragments + local overlays.
 * Deterministic order for every supported Compose invocation.
 */

import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import type { DesiredState } from "../domain/state.ts";
import type { Platform } from "../platform/mod.ts";
import { type GeneratedFile, withManagedMarker } from "./render.ts";
import { safetyError } from "../domain/errors.ts";

export type ComposeInvocation = {
  /** Ordered -f arguments relative to stack root or absolute. */
  files: string[];
  projectDir: string;
};

/**
 * Refuse volume-destructive down operations on the supported path.
 */
export function assertSafeComposeArgs(args: string[]): void {
  const lower = args.map((a) => a.toLowerCase());
  const isDown = lower.includes("down");
  if (!isDown) return;
  if (
    lower.includes("-v") ||
    lower.includes("--volumes") ||
    lower.includes("--rmi")
  ) {
    throw safetyError(
      "refusing docker compose down with volume/image destruction",
      "Remove -v/--volumes/--rmi. Durable MySQL/Redis volumes must not be deleted through Bento.",
    );
  }
}

export function assembleComposeDocuments(
  platform: Platform,
  state: DesiredState,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push({
    relPath: "compose/docker-compose.base.yml",
    content: withManagedMarker(renderBaseCompose()),
    mode: 0o644,
    managed: true,
  });

  for (const v of state.phpVersions) {
    // Always derive the image tag from version so upgrades retag cleanly.
    const image = `bento/php:${v.version}`;
    files.push({
      relPath: `compose/docker-compose.php-${v.service}.yml`,
      content: withManagedMarker(renderPhpFragment(v.service, image, String(v.version))),
      mode: 0o644,
      managed: true,
    });
  }

  for (const m of state.mysqlVersions) {
    files.push({
      relPath: `compose/docker-compose.${m.service}.yml`,
      content: withManagedMarker(
        renderMysqlFragment(m.service, m.image, m.volume),
      ),
      mode: 0o644,
      managed: true,
    });
  }

  // Aggregated project file listing for inspectability
  const list = buildComposeFileList(platform, state);
  files.push({
    relPath: "compose/compose.files",
    content: withManagedMarker(list.files.join("\n") + "\n"),
    mode: 0o644,
    managed: true,
  });

  // Convenience merged view (informational; runtime uses -f chain)
  files.push({
    relPath: "compose/docker-compose.generated.yml",
    content: withManagedMarker(
      `# Assembled file list (use docker compose with -f chain)\n` +
        list.files.map((f) => `# - ${f}`).join("\n") +
        "\n",
    ),
    mode: 0o644,
    managed: true,
  });

  return files;
}

export function buildComposeFileList(
  platform: Platform,
  state: DesiredState,
): ComposeInvocation {
  const gen = "generated/compose";
  const files: string[] = [
    `${gen}/docker-compose.base.yml`,
  ];
  for (const v of [...state.phpVersions].sort((a, b) => a.service.localeCompare(b.service))) {
    files.push(`${gen}/docker-compose.php-${v.service}.yml`);
  }
  for (const m of [...state.mysqlVersions].sort((a, b) => a.service.localeCompare(b.service))) {
    files.push(`${gen}/docker-compose.${m.service}.yml`);
  }
  // Local overlays in deterministic lexicographic order (operator-owned)
  // Actual disk scan happens at invoke time; list known pattern here.
  files.push("overlays/*.yml"); // expanded at invoke

  return {
    files,
    projectDir: platform.paths.paths.root,
  };
}

export async function resolveComposeFiles(
  platform: Platform,
  state: DesiredState,
): Promise<string[]> {
  const base = buildComposeFileList(platform, state);
  const resolved: string[] = [];
  for (const f of base.files) {
    if (f.endsWith("*.yml")) {
      const dir = join(platform.paths.paths.root, "overlays");
      if (await platform.fs.exists(dir)) {
        const names = (await platform.fs.readDir(dir))
          .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
          .sort();
        for (const n of names) resolved.push(join("overlays", n));
      }
    } else {
      resolved.push(f);
    }
  }
  return resolved;
}

export async function composeArgs(
  platform: Platform,
  state: DesiredState,
  command: string[],
): Promise<string[]> {
  assertSafeComposeArgs(command);
  const files = await resolveComposeFiles(platform, state);
  const args = ["docker", "compose", "--project-directory", platform.paths.paths.root];
  for (const f of files) {
    args.push("-f", join(platform.paths.paths.root, f));
  }
  args.push(...command);
  return args;
}

function renderBaseCompose(): string {
  // Project name + private network are scoped via COMPOSE_PROJECT_NAME (stack .env)
  // so a disposable test stack (e.g. testbento) does not collide with production.
  const doc = {
    name: "${COMPOSE_PROJECT_NAME:-bento}",
    networks: {
      private: {
        driver: "bridge",
        name: "${COMPOSE_PROJECT_NAME:-bento}_private",
      },
    },
    services: {
      nginx: {
        image: "bento/nginx:latest",
        build: {
          context: "./docker/nginx",
          dockerfile: "Dockerfile",
        },
        network_mode: "host",
        restart: "unless-stopped",
        volumes: [
          "./generated/nginx/nginx.conf:/etc/nginx/nginx.conf:ro",
          "./generated/nginx/sites:/etc/nginx/sites:ro",
          // Generated snippets fully replace image defaults (boot-ssl, app-common, per-site ssl).
          "./generated/nginx/snippets:/etc/nginx/snippets:ro",
          "./certs:/etc/nginx/certs",
          // Native Nginx ACME account keys, certificates, and renewal state.
          "./certs/acme-state:/var/cache/nginx/acme",
          "./homes:/home:ro",
          "./runtime/php-fpm:/run/php-fpm:ro",
          "./logs/nginx:/var/log/nginx",
        ],
      },
      redis: {
        image: "redis:7-alpine",
        restart: "unless-stopped",
        networks: ["private"],
        env_file: [".env"],
        // Private network only (no published ports). When REDIS_PASSWORD is set, require it;
        // otherwise disable protected-mode so sibling containers can connect.
        command: [
          "sh",
          "-c",
          'if [ -n "$$REDIS_PASSWORD" ]; then exec redis-server --appendonly yes --requirepass "$$REDIS_PASSWORD"; else exec redis-server --appendonly yes --protected-mode no; fi',
        ],
        volumes: ["redis-data:/data"],
        // no public ports
      },
    },
    volumes: {
      "redis-data": null,
    },
  };
  return stringifyYaml(doc);
}

function renderPhpFragment(service: string, image: string, version: string): string {
  const build = {
    context: "./docker/php",
    dockerfile: "Dockerfile",
    args: {
      PHP_VERSION: version,
    },
  };
  const doc = {
    services: {
      [service]: {
        image,
        build,
        restart: "unless-stopped",
        networks: ["private"],
        user: "root",
        // FPM's slowlog implementation ptraces a slow worker to capture its PHP backtrace.
        cap_add: ["SYS_PTRACE"],
        volumes: [
          "./homes:/home",
          // Pools directory is not matched by php-fpm.d/*.conf; include file below pulls it in.
          `./generated/php/${service}/pools:/usr/local/etc/php-fpm.d/bento:ro`,
          `./generated/php/${service}/zz-bento-pools.conf:/usr/local/etc/php-fpm.d/zz-bento-pools.conf:ro`,
          // Bind host entrypoint so entrypoint fixes apply without image rebuild.
          "./docker/php/entrypoint.sh:/usr/local/bin/bento-php-entrypoint:ro",
          `./runtime/php-fpm/${service}:/run/php-fpm`,
          "./helpers:/opt/bento/helpers:ro",
        ],
        environment: {
          BENTO_PHP_VERSION: version,
          BENTO_ROLE: "fpm",
        },
        // no public ports
      },
      [`${service}-runner`]: {
        image,
        // same image as FPM; do not rebuild twice — compose build reuses image tag
        restart: "unless-stopped",
        networks: ["private"],
        user: "root",
        // s6-overlay's /init is PID 1; its supervised CMD owns the dynamic app
        // scheduler/worker scan tree.
        entrypoint: ["/init"],
        command: ["/usr/local/bin/bento-runner-entrypoint"],
        volumes: [
          "./homes:/home",
          `./generated/runner/${service}/services:/etc/bento/services:ro`,
          `./generated/runner/${service}/cron:/etc/bento/cron:ro`,
          "./docker/php/runner-entrypoint.sh:/usr/local/bin/bento-runner-entrypoint:ro",
          "./docker/php/s6-reconcile.sh:/usr/local/bin/bento-s6-reconcile:ro",
          "./helpers:/opt/bento/helpers:ro",
          // The drain resets OPcache through the app's own FPM Unix socket.
          `./runtime/php-fpm/${service}:/run/php-fpm/${service}:ro`,
          `./runtime/locks/${service}:/run/bento`,
        ],
        environment: {
          BENTO_PHP_VERSION: version,
          BENTO_ROLE: "runner",
          S6_BEHAVIOUR_IF_STAGE2_FAILS: "2",
          S6_CMD_WAIT_FOR_SERVICES_MAXTIME: "0",
        },
      },
      // Ephemeral CLI profile (compose run --rm ${service}-cli ...)
      // Starts as root so entrypoint can install passwd/group for the app UID
      // (avoids bash "I have no name!"), then setpriv-drops to BENTO_UID:BENTO_GID.
      [`${service}-cli`]: {
        image,
        profiles: ["cli"],
        networks: ["private"],
        user: "root",
        entrypoint: ["bento-php-entrypoint"],
        working_dir: "/home",
        volumes: [
          "./homes:/home",
          // Bind host entrypoint so CLI identity fixes apply without image rebuild.
          "./docker/php/entrypoint.sh:/usr/local/bin/bento-php-entrypoint:ro",
          "./helpers:/opt/bento/helpers:ro",
        ],
        environment: {
          BENTO_PHP_VERSION: version,
          BENTO_ROLE: "cli",
        },
      },
    },
  };
  return stringifyYaml(doc);
}

function renderMysqlFragment(service: string, image: string, volume: string): string {
  const doc = {
    services: {
      [service]: {
        image,
        restart: "unless-stopped",
        networks: ["private"],
        // Password comes from stack .env (MYSQL_ROOT_PASSWORD); never on host argv.
        environment: {
          MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD}",
        },
        env_file: [".env"],
        volumes: [
          `${volume}:/var/lib/mysql`,
          `./generated/mysql/${service}:/etc/bento/mysql:ro`,
          `./backups/${service}:/var/backups/bento`,
        ],
        // no public ports
      },
    },
    volumes: {
      [volume]: null,
    },
  };
  return stringifyYaml(doc);
}
