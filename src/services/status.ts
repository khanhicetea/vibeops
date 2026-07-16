/**
 * Operator status view: services, apps, runtimes, domains, TLS, proxies, DB, capacity.
 */

import type { DesiredState } from "../domain/state.ts";
import type { Platform } from "../platform/mod.ts";
import { capacityWarnings } from "./app.ts";
import { FPM_PROFILES } from "../domain/types.ts";

export type StatusReport = {
  stackRoot: string;
  defaults: {
    phpVersion: string;
    mysqlVersion: string;
    fpmProfile: string;
    redisMode: string;
  };
  phpVersions: Array<{
    version: string;
    service: string;
    runner: string;
    processCap: number;
    appCount: number;
    poolMaxSum: number;
    overCap: boolean;
  }>;
  mysqlVersions: Array<{
    version: string;
    service: string;
    volume: string;
    appCount: number;
  }>;
  apps: Array<{
    slug: string;
    uid: number;
    gid: number;
    domain: string;
    aliases: string[];
    php: string;
    fpmProfile: string;
    entrypointMode: string;
    tls: string;
    accessLog: boolean;
    mysqlService: string;
    databases: string[];
    redisMode: string;
    deploy: boolean;
  }>;
  proxies: Array<{
    name: string;
    domain: string;
    upstream: string;
    tls: string;
  }>;
  domains: Array<{ domain: string; owner: string }>;
  cronJobs: number;
  workers: number;
  warnings: string[];
  generation?: {
    assetVersion?: string;
    renderedAt?: string;
  };
};

export async function buildStatus(
  platform: Platform,
  state: DesiredState,
): Promise<StatusReport> {
  const warnings = capacityWarnings(state);

  const phpVersions = state.phpVersions.map((v) => {
    const apps = Object.values(state.apps).filter((a) => a.phpVersion === v.version);
    let poolMaxSum = 0;
    for (const a of apps) {
      poolMaxSum += FPM_PROFILES[a.fpmProfile]?.maxChildren ?? 0;
    }
    return {
      version: v.version,
      service: v.service,
      runner: `${v.service}-runner`,
      processCap: v.processCap,
      appCount: apps.length,
      poolMaxSum,
      overCap: poolMaxSum > v.processCap,
    };
  });

  let generation: StatusReport["generation"];
  const genMeta = `${platform.paths.paths.generatedDir}/.generation.json`;
  if (await platform.fs.exists(genMeta)) {
    try {
      const raw = JSON.parse(await platform.fs.readText(genMeta)) as {
        assetVersion?: string;
        renderedAt?: string;
      };
      generation = {
        assetVersion: raw.assetVersion,
        renderedAt: raw.renderedAt,
      };
    } catch {
      warnings.push("generation metadata is unreadable");
    }
  } else {
    warnings.push("stack has not been rendered yet");
  }

  return {
    stackRoot: platform.paths.paths.root,
    defaults: {
      phpVersion: state.defaults.phpVersion,
      mysqlVersion: state.defaults.mysqlVersion,
      fpmProfile: state.defaults.fpmProfile,
      redisMode: state.defaults.redisMode,
    },
    phpVersions,
    mysqlVersions: state.mysqlVersions.map((m) => ({
      version: m.version,
      service: m.service,
      volume: m.volume,
      appCount: Object.values(state.apps).filter((a) => a.mysqlService === m.service)
        .length,
    })),
    apps: Object.values(state.apps)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((a) => ({
        slug: a.slug,
        uid: a.uid,
        gid: a.gid,
        domain: a.mainDomain,
        aliases: a.aliases.map(String),
        php: a.phpVersion,
        fpmProfile: a.fpmProfile,
        entrypointMode: a.entrypointMode,
        tls: a.tls.kind,
        accessLog: a.accessLog,
        mysqlService: a.mysqlService,
        databases: a.databases.map((d) => d.name),
        redisMode: a.redis.mode,
        deploy: a.deploy.enabled,
      })),
    proxies: Object.values(state.proxies)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        name: p.name,
        domain: p.mainDomain,
        upstream: p.upstream,
        tls: p.tls.kind,
      })),
    domains: Object.entries(state.domains)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, owner]) => ({
        domain,
        owner: owner.kind === "app" ? `app:${owner.slug}` : `proxy:${owner.name}`,
      })),
    cronJobs: state.cronJobs.length,
    workers: state.workers.length,
    warnings,
    generation,
  };
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Bento status`);
  lines.push(`  stack: ${report.stackRoot}`);
  if (report.generation?.renderedAt) {
    lines.push(
      `  generation: ${report.generation.renderedAt} (assets ${
        report.generation.assetVersion ?? "?"
      })`,
    );
  }
  lines.push(
    `  defaults: php=${report.defaults.phpVersion} mysql=${report.defaults.mysqlVersion} fpm=${report.defaults.fpmProfile} redis=${report.defaults.redisMode}`,
  );
  lines.push("");
  lines.push("PHP runtimes:");
  for (const v of report.phpVersions) {
    const flag = v.overCap ? " WARN over capacity" : "";
    lines.push(
      `  ${v.version}  fpm=${v.service}  runner=${v.runner}  apps=${v.appCount}  pools=${v.poolMaxSum}/${v.processCap}${flag}`,
    );
  }
  lines.push("");
  lines.push("MySQL services:");
  for (const m of report.mysqlVersions) {
    lines.push(
      `  ${m.version}  service=${m.service}  volume=${m.volume}  apps=${m.appCount}`,
    );
  }
  lines.push("");
  lines.push("Apps:");
  if (report.apps.length === 0) lines.push("  (none)");
  for (const a of report.apps) {
    lines.push(
      `  ${a.slug}  uid=${a.uid}  ${a.domain}  php=${a.php}/${a.fpmProfile}  tls=${a.tls}  entry=${a.entrypointMode}  db=${a.mysqlService}[${
        a.databases.join(",") || "-"
      }]  redis=${a.redisMode}  deploy=${a.deploy ? "on" : "off"}`,
    );
  }
  lines.push("");
  lines.push("Proxies:");
  if (report.proxies.length === 0) lines.push("  (none)");
  for (const p of report.proxies) {
    lines.push(`  ${p.name}  ${p.domain} -> ${p.upstream}  tls=${p.tls}`);
  }
  lines.push("");
  lines.push(
    `Background: cron_jobs=${report.cronJobs} workers=${report.workers}`,
  );
  if (report.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n") + "\n";
}
