/**
 * Shared helpers for the integration suite (Phase F2).
 *
 * Integration tests exercise the CLI against temporary stack roots and, when
 * Docker is available, `docker compose config` validation. Live MySQL/Redis
 * data-plane steps soft-skip when those services are not up.
 */

import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { runCli } from "../../src/main.ts";

export type StackHarness = {
  stack: string;
  base: string[];
  run: (...args: string[]) => Promise<number>;
};

let dockerAvailable: boolean | undefined;

/** True when the Docker daemon answers `docker info`. */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== undefined) return dockerAvailable;
  try {
    const cmd = new Deno.Command("docker", {
      args: ["info"],
      stdout: "null",
      stderr: "null",
    });
    const out = await cmd.output();
    dockerAvailable = out.code === 0;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/** True when `docker compose version` works. */
export async function isComposeAvailable(): Promise<boolean> {
  if (!(await isDockerAvailable())) return false;
  try {
    const cmd = new Deno.Command("docker", {
      args: ["compose", "version"],
      stdout: "null",
      stderr: "null",
    });
    const out = await cmd.output();
    return out.code === 0;
  } catch {
    return false;
  }
}

export async function withStack(fn: (h: StackHarness) => Promise<void>): Promise<void> {
  const stack = await Deno.makeTempDir({ prefix: "bento-int-" });
  const base = ["--stack", stack, "--repo-root", Deno.cwd()];
  const harness: StackHarness = {
    stack,
    base,
    run: (...args: string[]) => runCli([...base, ...args]),
  };
  try {
    await fn(harness);
  } finally {
    await Deno.remove(stack, { recursive: true }).catch(() => {});
  }
}

export async function bootstrapStack(h: StackHarness): Promise<void> {
  assertEquals(await h.run("init"), 0);
  assertEquals(await h.run("render"), 0);
}

export async function readText(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export function gen(h: StackHarness, ...parts: string[]): string {
  return join(h.stack, "generated", ...parts);
}

export function home(h: StackHarness, slug: string, ...parts: string[]): string {
  return join(h.stack, "homes", slug, ...parts);
}

/** Run docker compose config -q against the stack's generated file list. */
export async function composeConfigValidate(
  h: StackHarness,
): Promise<{ ok: boolean; detail: string }> {
  if (!(await isComposeAvailable())) {
    return { ok: false, detail: "docker compose unavailable" };
  }
  // Prefer bento compose files listing when present
  const listPath = gen(h, "compose", "compose.files");
  let files: string[] = [];
  if (await exists(listPath)) {
    const text = await readText(listPath);
    files = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.includes("*"));
  }
  if (files.length === 0) {
    files = [
      "generated/compose/docker-compose.base.yml",
      "generated/compose/docker-compose.php-php85.yml",
      "generated/compose/docker-compose.mysql84.yml",
    ];
  }
  const args = ["compose"];
  for (const f of files) {
    args.push("-f", f.startsWith("/") ? f : join(h.stack, f));
  }
  args.push("config", "-q");
  try {
    const cmd = new Deno.Command("docker", {
      args,
      cwd: h.stack,
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        // Compose may interpolate; seed from stack .env if present
      },
    });
    // docker compose reads .env from project directory
    const out = await cmd.output();
    const detail = new TextDecoder().decode(out.stderr) +
      new TextDecoder().decode(out.stdout);
    return { ok: out.code === 0, detail };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Soft-check whether a named compose service is running (best-effort). */
export async function isServiceRunning(
  h: StackHarness,
  service: string,
): Promise<boolean> {
  if (!(await isDockerAvailable())) return false;
  try {
    const cmd = new Deno.Command("docker", {
      args: ["compose", "ps", "--status", "running", "-q", service],
      cwd: h.stack,
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (out.code !== 0) return false;
    return new TextDecoder().decode(out.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

export function skipIf(
  condition: boolean,
  reason: string,
): boolean {
  if (condition) {
    console.log(`  [skip] ${reason}`);
    return true;
  }
  return false;
}

export { assertEquals, join, resolve };
