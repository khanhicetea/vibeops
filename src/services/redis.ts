/**
 * Redis mode helpers: shared-password + prefix, or per-app ACL.
 * Secrets are never placed on host process argv.
 */

import type { AppRedisIdentity, AppState, DesiredState } from "../domain/state.ts";
import { notFoundError, serviceError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";

export function redisConnectionEnv(
  app: AppState,
  sharedPassword?: string,
): Record<string, string> {
  const base: Record<string, string> = {
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    REDIS_PREFIX: app.redis.prefix,
    REDIS_MODE: app.redis.mode,
  };
  if (app.redis.mode === "shared") {
    base.REDIS_PASSWORD = app.redis.password ?? sharedPassword ?? "";
  } else {
    base.REDIS_USERNAME = app.redis.aclUsername ?? `app_${app.slug}`;
    base.REDIS_PASSWORD = app.redis.aclPassword ?? "";
  }
  return base;
}

/** ACL rule components restricting keys/channels to the app prefix. */
export function aclRuleParts(identity: AppRedisIdentity): {
  username: string;
  prefix: string;
  capabilityArgs: string[];
} {
  const prefix = identity.prefix;
  const user = identity.aclUsername ?? "app";
  return {
    username: user,
    prefix,
    capabilityArgs: [`~${prefix}*`, `&${prefix}*`, "+@all", "-@dangerous"],
  };
}

/** Full ACL SETUSER rule string for tests/docs (includes password marker). */
export function aclRules(identity: AppRedisIdentity): string[] {
  const { username, capabilityArgs } = aclRuleParts(identity);
  const pw = identity.aclPassword ?? "";
  return [
    `ACL SETUSER ${username} on >${pw} ${capabilityArgs.join(" ")}`,
  ];
}

/**
 * Apply per-app Redis ACL when Redis is up.
 * Auth password and ACL password travel only on stdin, never host argv.
 *
 * stdin format:
 *   line 1: redis AUTH password (may be empty)
 *   line 2: ACL user password
 */
export async function applyAppRedisAcl(
  platform: Platform,
  app: AppState,
  redisAuthPassword?: string,
): Promise<void> {
  if (app.redis.mode !== "acl") return;
  const password = app.redis.aclPassword;
  if (!password) {
    throw serviceError(
      `app ${app.slug} is in ACL mode but has no aclPassword`,
      "Re-run app provisioning so an ACL password is generated.",
    );
  }
  const { username, capabilityArgs } = aclRuleParts(app.redis);

  const applyScript = [
    "set -e",
    "IFS= read -r AUTH",
    "IFS= read -r ACLPW",
    'if [ -n "$AUTH" ]; then export REDISCLI_AUTH="$AUTH"; fi',
    `redis-cli --no-auth-warning ACL SETUSER ${
      shellQuote(username)
    } on "$(printf '>%s' "$ACLPW")" ${capabilityArgs.map(shellQuote).join(" ")}`,
  ].join("\n");

  const stdin = `${redisAuthPassword ?? ""}\n${password}\n`;
  const result = await platform.process.run(
    ["docker", "compose", "exec", "-T", "redis", "sh", "-c", applyScript],
    {
      cwd: platform.paths.paths.root,
      stdin,
      timeoutMs: 15_000,
    },
  );
  if (result.code !== 0) {
    throw serviceError(
      `Redis ACL apply failed for app ${app.slug}: ${
        (result.stderr || result.stdout || "unknown error").trim()
      }`,
      "Ensure the redis service is running and REDIS_PASSWORD matches, then retry.",
    );
  }
}

/**
 * Best-effort ACL apply; returns false when Redis is down or apply fails.
 */
export async function tryApplyAppRedisAcl(
  platform: Platform,
  app: AppState,
  redisAuthPassword?: string,
): Promise<boolean> {
  if (app.redis.mode !== "acl") return true;
  if (!(await isRedisReachable(platform))) return false;
  try {
    await applyAppRedisAcl(platform, app, redisAuthPassword);
    return true;
  } catch {
    return false;
  }
}

export async function isRedisReachable(platform: Platform): Promise<boolean> {
  try {
    const result = await platform.process.run(
      ["docker", "compose", "exec", "-T", "redis", "true"],
      { cwd: platform.paths.paths.root, timeoutMs: 8_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

export function ensureRedisIdentity(
  state: DesiredState,
  slug: string,
  platform: Platform,
): DesiredState {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  if (app.redis.mode === "acl" && !app.redis.aclPassword) {
    const next = {
      ...app,
      redis: {
        ...app.redis,
        aclUsername: app.redis.aclUsername ?? `app_${slug}`,
        aclPassword: platform.random.hex(18),
      },
      updatedAt: platform.clock.nowIso(),
    };
    return {
      ...state,
      apps: { ...state.apps, [slug]: next },
      updatedAt: next.updatedAt,
    };
  }
  return state;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
