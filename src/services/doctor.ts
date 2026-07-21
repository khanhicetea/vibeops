/** Comprehensive, non-mutating host and stack diagnostics. */

import { basename, dirname, join, resolve } from "@std/path";
import pc from "picocolors";
import type { DesiredState, TlsMode } from "../domain/state.ts";
import type { Platform, RunResult } from "../platform/mod.ts";
import { checkPermissions } from "./permissions.ts";
import { composeArgs } from "./compose.ts";
import { buildStatus, statusToJson } from "./status.ts";
import { redact } from "../ui/output.ts";

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorCheck = {
  id: string;
  category: string;
  status: DoctorStatus;
  detail: string;
};
export type DoctorReport = {
  generatedAt: string;
  stackRoot: string;
  ok: boolean;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
};

const run = async (platform: Platform, command: string[], timeoutMs = 5_000) =>
  await platform.process.run(command, { cwd: platform.paths.paths.root, timeoutMs }).catch((e) => ({
    code: 1,
    stdout: "",
    stderr: e instanceof Error ? e.message : String(e),
  }));

export async function runDoctor(platform: Platform, state: DesiredState): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, category: string, status: DoctorStatus, detail: string) =>
    checks.push({ id, category, status, detail: redact(detail).slice(0, 500) });

  const docker = await run(platform, ["docker", "version", "--format", "{{.Server.Version}}"]);
  if (docker.code !== 0) add("docker-version", "runtime", "fail", "Docker daemon unavailable");
  else {
    const version = docker.stdout.trim();
    add(
      "docker-version",
      "runtime",
      versionAtLeast(version, 20, 10) ? "pass" : "fail",
      `Docker ${version} (minimum 20.10)`,
    );
  }
  const compose = await run(platform, ["docker", "compose", "version", "--short"]);
  if (compose.code !== 0) {
    add("compose-version", "runtime", "fail", "Docker Compose v2 unavailable");
  } else {
    const version = compose.stdout.trim().replace(/^v/, "");
    add(
      "compose-version",
      "runtime",
      versionAtLeast(version, 2, 20) ? "pass" : "fail",
      `Compose ${version} (minimum 2.20)`,
    );
  }

  const ports = await run(platform, ["ss", "-H", "-ltn"]);
  for (const port of [80, 443]) {
    if (ports.code !== 0) {
      add(`port-${port}`, "network", "warn", "cannot inspect listening TCP ports (ss unavailable)");
    } else {
      const listening = ports.stdout.split("\n").some((line) =>
        new RegExp(`[:.]${port}\\s`).test(line)
      );
      add(
        `port-${port}`,
        "network",
        listening ? "pass" : "warn",
        listening ? `TCP ${port} is listening` : `TCP ${port} is not listening`,
      );
    }
  }

  await addFilesystemChecks(platform, add);
  await addClockCheck(platform, add);

  const domains = [...new Set(Object.keys(state.domains))].sort();
  for (const domain of domains) {
    const dns = await run(platform, ["getent", "ahosts", domain], 3_000);
    add(
      `dns:${domain}`,
      "dns",
      dns.code === 0 && !!dns.stdout.trim() ? "pass" : "fail",
      dns.code === 0 ? `${domain} resolves` : `${domain} does not resolve`,
    );
  }

  for (const cert of certificatePaths(platform, state)) {
    if (!cert.live && !(await platform.fs.exists(cert.path))) {
      add(
        `certificate:${cert.name}`,
        "tls",
        cert.optional ? "warn" : "fail",
        `certificate missing: ${cert.name}`,
      );
      continue;
    }
    const result = cert.live
      ? await run(platform, [
        "sh",
        "-c",
        `openssl s_client -connect '${cert.name}:443' -servername '${cert.name}' </dev/null 2>/dev/null | openssl x509 -noout -checkend 2592000`,
      ], 8_000)
      : await run(platform, [
        "openssl",
        "x509",
        "-in",
        cert.path,
        "-noout",
        "-checkend",
        "2592000",
      ]);
    add(
      `certificate:${cert.name}`,
      "tls",
      result.code === 0 ? "pass" : "warn",
      result.code === 0
        ? `${cert.name} valid for at least 30 days`
        : `${cert.name} expires within 30 days or is unreadable`,
    );
  }

  await addServiceChecks(platform, state, add, docker.code === 0);
  await addPermissionChecks(platform, state, add);
  await addVolumeChecks(platform, state, add);

  const overlays = await platform.fs.exists(platform.paths.paths.overlaysDir)
    ? (await platform.fs.readDir(platform.paths.paths.overlaysDir)).filter((n) =>
      /\.ya?ml$/.test(n)
    )
    : [];
  let config: RunResult;
  try {
    const configArgs = await composeArgs(platform, state, ["config", "--quiet"]);
    config = await run(platform, configArgs, 10_000);
  } catch (e) {
    config = { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  add(
    "compose-config",
    "overlays",
    config.code === 0 ? "pass" : "fail",
    config.code === 0
      ? `Compose configuration valid (${overlays.length} overlay(s))`
      : `Compose/overlay configuration invalid: ${config.stderr || config.stdout}`,
  );

  await addSecretModeChecks(platform, state, add);

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  return {
    generatedAt: platform.clock.nowIso(),
    stackRoot: platform.paths.paths.root,
    ok: summary.fail === 0,
    checks,
    summary,
  };
}

type AddCheck = (id: string, category: string, status: DoctorStatus, detail: string) => void;

async function addFilesystemChecks(platform: Platform, add: AddCheck) {
  for (
    const [id, flag, label] of [["disk-space", "-Pk", "disk"], [
      "disk-inodes",
      "-Pi",
      "inodes",
    ]] as const
  ) {
    const result = await run(platform, ["df", flag, platform.paths.paths.root]);
    const match = result.stdout.trim().split("\n").at(-1)?.match(/\s(\d+)%\s+\S+$/);
    if (result.code !== 0 || !match) add(id, "storage", "warn", `cannot inspect ${label}`);
    else {
      const used = Number(match[1]);
      add(
        id,
        "storage",
        used >= 95 ? "fail" : used >= 85 ? "warn" : "pass",
        `${label} ${used}% used`,
      );
    }
  }
}

async function addClockCheck(platform: Platform, add: AddCheck) {
  const now = platform.clock.now();
  if (!Number.isFinite(now.getTime()) || now.getUTCFullYear() < 2024) {
    const shown = Number.isFinite(now.getTime()) ? now.toISOString() : String(now);
    add("clock", "host", "fail", `host clock is not plausible: ${shown}`);
  } else {
    const ntp = await run(platform, ["timedatectl", "show", "-p", "NTPSynchronized", "--value"]);
    add(
      "clock",
      "host",
      ntp.code !== 0 ? "warn" : ntp.stdout.trim() === "yes" ? "pass" : "warn",
      ntp.code !== 0
        ? `clock ${now.toISOString()}; NTP status unavailable`
        : `clock ${now.toISOString()}; NTP synchronized=${ntp.stdout.trim()}`,
    );
  }
}

async function addServiceChecks(
  platform: Platform,
  state: DesiredState,
  add: AddCheck,
  dockerOk: boolean,
) {
  if (!dockerOk) {
    add("services", "health", "fail", "service probes skipped because Docker is unavailable");
    return;
  }
  const probes: Array<[string, string, string[]]> = [
    ["nginx", "nginx", ["nginx", "-t"]],
    ["redis", "redis", ["redis-cli", "ping"]],
    ...state.phpVersions.map((
      v,
    ): [string, string, string[]] => [`php:${v.service}`, v.service, ["php-fpm", "-t"]]),
    ...state.mysqlVersions.map((
      v,
    ): [string, string, string[]] => [`mysql:${v.service}`, v.service, [
      "mysqladmin",
      "ping",
      "-h",
      "127.0.0.1",
      "--silent",
    ]]),
  ];
  for (const [id, service, command] of probes) {
    let result: RunResult;
    try {
      const args = await composeArgs(platform, state, ["exec", "-T", service, ...command]);
      result = await run(platform, args, 5_000);
    } catch (e) {
      result = { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
    const redisOk = id === "redis" ? result.stdout.trim().toUpperCase() === "PONG" : true;
    add(
      id,
      "health",
      result.code === 0 && redisOk ? "pass" : "fail",
      result.code === 0 && redisOk
        ? `${service} healthy`
        : `${service} probe failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function addPermissionChecks(platform: Platform, state: DesiredState, add: AddCheck) {
  for (
    const app of Object.values(state.apps).sort((a, b) =>
      String(a.slug).localeCompare(String(b.slug))
    )
  ) {
    try {
      const report = await checkPermissions(platform, state, String(app.slug));
      add(
        `permissions:${app.slug}`,
        "permissions",
        report.issues.length ? "fail" : "pass",
        report.issues.length
          ? `${report.issues.length} issue(s): ${
            report.issues.slice(0, 3).map((i) => `${i.path}: ${i.issue}`).join("; ")
          }`
          : `${report.checked} paths checked`,
      );
    } catch (e) {
      add(
        `permissions:${app.slug}`,
        "permissions",
        "fail",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

async function addVolumeChecks(platform: Platform, state: DesiredState, add: AddCheck) {
  let project = "bento";
  if (await platform.fs.exists(platform.paths.paths.envFile)) {
    const env = await platform.fs.readText(platform.paths.paths.envFile);
    project = env.match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1]?.trim() || project;
  }
  const volumes = ["redis-data", ...state.mysqlVersions.map((m) => m.volume)];
  for (const logical of volumes) {
    const name = `${project}_${logical}`;
    const result = await run(platform, ["docker", "volume", "inspect", name]);
    add(
      `volume:${logical}`,
      "storage",
      result.code === 0 ? "pass" : "fail",
      result.code === 0 ? `volume ${name} exists` : `volume ${name} missing`,
    );
  }
}

async function addSecretModeChecks(
  platform: Platform,
  state: DesiredState,
  add: AddCheck,
) {
  const paths = platform.paths.paths;
  const candidates = [paths.envFile, paths.stateFile, join(paths.certsDir, "boot.key")];
  for (const app of Object.values(state.apps)) {
    if (app.tls.kind === "external") candidates.push(resolve(paths.certsDir, app.tls.keyPath));
    if (app.tls.kind === "self-ca") {
      candidates.push(join(paths.certsDir, "private-ca", "sites", `${app.slug}.key`));
    }
  }
  for (const proxy of Object.values(state.proxies)) {
    if (proxy.tls.kind === "external") candidates.push(resolve(paths.certsDir, proxy.tls.keyPath));
    if (proxy.tls.kind === "self-ca") {
      candidates.push(join(paths.certsDir, "private-ca", "sites", `proxy-${proxy.name}.key`));
    }
  }
  for (const dir of [paths.secretsDir, join(paths.certsDir, "private-ca")]) {
    if (await platform.fs.exists(dir)) {
      for (const name of await platform.fs.readDir(dir)) candidates.push(join(dir, name));
    }
  }
  for (const path of candidates) {
    if (!(await platform.fs.exists(path))) continue;
    const stat = await platform.fs.lstat(path);
    if (!stat.isFile) continue;
    const mode = stat.mode & 0o777;
    add(
      `secret-mode:${basename(path)}`,
      "secrets",
      (mode & 0o077) === 0 ? "pass" : "fail",
      `${path} mode ${mode.toString(8)} (expected no group/world access)`,
    );
  }
}

function certificatePaths(platform: Platform, state: DesiredState) {
  const certs: Array<{ name: string; path: string; optional: boolean; live?: boolean }> = [];
  const add = (name: string, tls: TlsMode, id: string) => {
    if (tls.kind === "self-ca") {
      certs.push({
        name,
        path: join(platform.paths.paths.certsDir, "private-ca", "sites", `${id}.crt`),
        optional: false,
      });
    }
    if (tls.kind === "external") {
      certs.push({
        name,
        path: resolve(platform.paths.paths.certsDir, tls.certPath),
        optional: false,
      });
    }
    if (tls.kind === "acme") {
      certs.push({
        name,
        path: join(platform.paths.paths.certsDir, "acme-state"),
        optional: true,
        live: true,
      });
    }
  };
  for (const app of Object.values(state.apps)) {
    add(String(app.mainDomain), app.tls, String(app.slug));
  }
  for (const proxy of Object.values(state.proxies)) {
    add(String(proxy.mainDomain), proxy.tls, `proxy-${proxy.name}`);
  }
  if (
    [...Object.values(state.apps), ...Object.values(state.proxies)].some((s) =>
      s.tls.kind === "shared"
    )
  ) {
    certs.push({
      name: "shared boot certificate",
      path: join(platform.paths.paths.certsDir, "boot.crt"),
      optional: false,
    });
  }
  return certs;
}

function versionAtLeast(value: string, major: number, minor: number): boolean {
  const m = value.match(/(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > major || (Number(m[1]) === major && Number(m[2]) >= minor));
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    `Bento doctor (${report.ok ? "healthy" : "problems found"})`,
    `  stack: ${report.stackRoot}`,
    "",
  ];
  let category = "";
  for (const check of report.checks) {
    if (check.category !== category) {
      category = check.category;
      lines.push(`${category}:`);
    }
    const label = check.status.toUpperCase();
    const colored = check.status === "pass"
      ? pc.green(label)
      : check.status === "fail"
      ? pc.red(label)
      : pc.yellow(label);
    lines.push(`  [${colored}] ${check.id}: ${check.detail}`);
  }
  lines.push(
    "",
    `Summary: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed`,
  );
  return lines.join("\n") + "\n";
}

/** Create a tar.gz containing only redacted, operator-safe diagnostic text. */
export async function createSupportBundle(
  platform: Platform,
  state: DesiredState,
  output: string,
): Promise<string> {
  const destination = resolve(output);
  const temp = join(platform.paths.paths.root, `.support-${platform.random.id()}`);
  await platform.fs.mkdirp(dirname(destination), 0o700);
  await platform.fs.mkdirp(temp, 0o700);
  try {
    const doctor = await runDoctor(platform, state);
    const status = await buildStatus(platform, state);
    await platform.fs.writeText(join(temp, "doctor.json"), safeJson(doctor), 0o600);
    await platform.fs.writeText(join(temp, "status.json"), redact(statusToJson(status)), 0o600);
    await platform.fs.writeText(
      join(temp, "state.redacted.json"),
      safeJson(redactObject(state)),
      0o600,
    );
    if (await platform.fs.exists(platform.paths.paths.envFile)) {
      const env = await platform.fs.readText(platform.paths.paths.envFile);
      await platform.fs.writeText(
        join(temp, "environment.redacted.txt"),
        redactEnvironment(env),
        0o600,
      );
    }
    const composePs = await composeArgs(platform, state, ["ps", "--all"]).catch(() => [
      "docker",
      "compose",
      "ps",
      "--all",
    ]);
    for (
      const [name, command] of [
        ["docker-info.txt", ["docker", "info"]],
        ["compose-ps.txt", composePs],
        ["system.txt", ["uname", "-a"]],
      ] as Array<[string, string[]]>
    ) {
      const result: RunResult = await run(platform, command, 10_000);
      await platform.fs.writeText(
        join(temp, name),
        redact(`${result.stdout}\n${result.stderr}`),
        0o600,
      );
    }
    const partial = `${destination}.partial`;
    await platform.fs.remove(partial).catch(() => undefined);
    const tar = await platform.process.run(["tar", "-czf", partial, "-C", temp, "."], {
      timeoutMs: 30_000,
    });
    if (tar.code !== 0) {
      await platform.fs.remove(partial).catch(() => undefined);
      throw new Error(`failed to create support bundle: ${tar.stderr || tar.stdout}`);
    }
    await platform.fs.chmod(partial, 0o600);
    await platform.fs.rename(partial, destination);
    return destination;
  } finally {
    await platform.fs.remove(temp, { recursive: true });
  }
}

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = /(pass(word)?|secret|token|private.?key|hmac|credential)/i.test(key)
        ? "***"
        : redactObject(item);
    }
    return out;
  }
  return typeof value === "string" ? redact(value) : value;
}
function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}
function redactEnvironment(text: string): string {
  return text.split("\n").map((line) => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (!match) return line;
    return /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|AUTH)/i.test(match[1]!) ? `${match[1]}=***` : line;
  }).join("\n");
}
