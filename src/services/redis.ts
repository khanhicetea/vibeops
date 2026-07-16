/**
 * Redis mode helpers: shared-password + prefix, or per-app ACL.
 */

import type { AppRedisIdentity, AppState, DesiredState } from "../domain/state.ts";
import { notFoundError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";

export function redisConnectionEnv(app: AppState): Record<string, string> {
  const base: Record<string, string> = {
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    REDIS_PREFIX: app.redis.prefix,
    REDIS_MODE: app.redis.mode,
  };
  if (app.redis.mode === "shared") {
    base.REDIS_PASSWORD = app.redis.password ?? "";
  } else {
    base.REDIS_USERNAME = app.redis.aclUsername ?? `app_${app.slug}`;
    base.REDIS_PASSWORD = app.redis.aclPassword ?? "";
  }
  return base;
}

/** ACL rules restricting keys/channels to app prefix. */
export function aclRules(identity: AppRedisIdentity): string[] {
  const prefix = identity.prefix;
  const user = identity.aclUsername ?? "app";
  // ~prefix* keys, &prefix* channels
  return [
    `ACL SETUSER ${user} on >${
      identity.aclPassword ?? ""
    } ~${prefix}* &${prefix}* +@all -@dangerous`,
  ];
}

export async function applyAppRedisAcl(
  platform: Platform,
  app: AppState,
  sharedPassword?: string,
): Promise<void> {
  if (app.redis.mode !== "acl") return;
  const rules = aclRules(app.redis);
  for (const rule of rules) {
    const args = ["docker", "compose", "exec", "-T", "redis", "redis-cli"];
    if (sharedPassword) {
      args.push("-a", sharedPassword, "--no-auth-warning");
    }
    // Pass ACL command as separate args after --
    const parts = rule.split(/\s+/);
    args.push(...parts);
    await platform.process.run(args, {
      cwd: platform.paths.paths.root,
      timeoutMs: 15_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
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
