/**
 * Load operator-owned stack environment (.env) without putting secrets on argv.
 */

import type { Platform } from "../platform/mod.ts";
import { secretError } from "../domain/errors.ts";

/** Parse a dotenv-style document into a flat string map. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read stack `.env` if present. */
export async function loadStackEnv(platform: Platform): Promise<Record<string, string>> {
  const path = platform.paths.paths.envFile;
  if (!(await platform.fs.exists(path))) return {};
  try {
    return parseDotEnv(await platform.fs.readText(path));
  } catch {
    return {};
  }
}

export async function loadMysqlRootPassword(
  platform: Platform,
): Promise<string | undefined> {
  const env = await loadStackEnv(platform);
  const value = env.MYSQL_ROOT_PASSWORD;
  if (value === undefined || value === "") return undefined;
  return value;
}

export async function requireMysqlRootPassword(platform: Platform): Promise<string> {
  const value = await loadMysqlRootPassword(platform);
  if (value === undefined) {
    throw secretError(
      "MYSQL_ROOT_PASSWORD is not set in the stack .env",
      "Run `bento init` or set MYSQL_ROOT_PASSWORD in the stack .env (mode 0600).",
    );
  }
  return value;
}

export async function loadRedisPassword(platform: Platform): Promise<string> {
  const env = await loadStackEnv(platform);
  return env.REDIS_PASSWORD ?? "";
}
