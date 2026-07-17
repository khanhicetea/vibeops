/**
 * App-owned vhost/pool template customization with provenance and drift (F-24).
 * Custom sources are user-owned; returning to upstream never deletes them.
 */

import { dirname, join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { DesiredState, TemplateProvenance } from "../domain/state.ts";
import { notFoundError, validationError } from "../domain/errors.ts";
import type { ReloadPlan } from "../domain/reload.ts";
import { reloadPlanForDomainChange, reloadPlanForPoolChange } from "../domain/reload.ts";
import type { Platform } from "../platform/mod.ts";

export type TemplateKind = "vhost" | "pool";

const UPSTREAM_ASSET: Record<TemplateKind, string> = {
  vhost: "nginx/app-vhost.conf.tpl",
  pool: "php/pool.conf.tpl",
};

export type SelectTemplateInput = {
  slug: string;
  kind: TemplateKind;
  /**
   * Path to operator-owned source.
   * When `copy` is true, content is copied under stack custom/ and that path is recorded.
   * When false, sourcePath is recorded as-is (must remain readable).
   */
  sourcePath: string;
  /** Copy into stack custom/ tree (default true). */
  copy?: boolean;
};

export type SelectTemplateResult = {
  state: DesiredState;
  provenance: TemplateProvenance;
  recordedPath: string;
  reloadPlan: ReloadPlan;
  /** Upstream digest captured at activation for later drift detection. */
  upstreamDigest: string;
};

/** SHA-256 hex digest of bytes. */
export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice());
  return encodeHex(new Uint8Array(hash));
}

export async function digestText(text: string): Promise<string> {
  return await digestBytes(new TextEncoder().encode(text));
}

/** Read upstream template content and digest. */
export async function upstreamTemplateDigest(
  platform: Platform,
  kind: TemplateKind,
): Promise<{ content: string; digest: string }> {
  const content = await platform.assets.readText(UPSTREAM_ASSET[kind]);
  return { content, digest: await digestText(content) };
}

/**
 * Activate a custom vhost or pool template for an app.
 * Records provenance (source path + upstream digest at activation).
 */
export async function selectCustomTemplate(
  platform: Platform,
  state: DesiredState,
  input: SelectTemplateInput,
): Promise<SelectTemplateResult> {
  const app = state.apps[input.slug];
  if (!app) throw notFoundError(`app not found: ${input.slug}`);
  if (!(await platform.fs.exists(input.sourcePath))) {
    throw validationError(`template source not found: ${input.sourcePath}`);
  }
  const st = await platform.fs.stat(input.sourcePath);
  if (!st.isFile) throw validationError(`template source is not a file: ${input.sourcePath}`);

  const sourceText = await platform.fs.readText(input.sourcePath);
  if (!sourceText.trim()) {
    throw validationError("template source is empty");
  }

  const { digest: upstreamDigest } = await upstreamTemplateDigest(platform, input.kind);
  const now = platform.clock.nowIso();
  const copy = input.copy !== false;

  let recordedPath = input.sourcePath;
  if (copy) {
    const destDir = join(
      platform.paths.paths.customDir,
      "apps",
      input.slug,
      input.kind,
    );
    await platform.fs.mkdirp(destDir, 0o755);
    const dest = join(destDir, input.kind === "vhost" ? "vhost.conf.tpl" : "pool.conf.tpl");
    await platform.fs.writeText(dest, sourceText, 0o644);
    recordedPath = dest;
  }

  const provenance: TemplateProvenance = {
    kind: "custom",
    sourcePath: recordedPath,
    copiedFromVersion: upstreamDigest,
    activatedAt: now,
  };

  const nextApp = input.kind === "vhost"
    ? { ...app, vhostTemplate: provenance, updatedAt: now }
    : { ...app, poolTemplate: provenance, updatedAt: now };

  const reloadPlan = input.kind === "vhost"
    ? reloadPlanForDomainChange()
    : reloadPlanForPoolChange(app.phpService);

  return {
    state: {
      ...state,
      apps: { ...state.apps, [input.slug]: nextApp },
      updatedAt: now,
    },
    provenance,
    recordedPath,
    reloadPlan,
    upstreamDigest,
  };
}

export type ReturnToUpstreamResult = {
  state: DesiredState;
  /** Custom source left on disk (never deleted). */
  preservedPath?: string;
  reloadPlan: ReloadPlan;
};

/**
 * Return an app template to upstream.
 * Must not delete the custom source file (F-24).
 */
export function returnToUpstreamTemplate(
  state: DesiredState,
  slug: string,
  kind: TemplateKind,
  now: string,
): ReturnToUpstreamResult {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);

  const current = kind === "vhost" ? app.vhostTemplate : app.poolTemplate;
  const preservedPath = current.kind === "custom" ? current.sourcePath : undefined;

  const nextApp = kind === "vhost"
    ? { ...app, vhostTemplate: { kind: "upstream" as const }, updatedAt: now }
    : { ...app, poolTemplate: { kind: "upstream" as const }, updatedAt: now };

  const reloadPlan = kind === "vhost"
    ? reloadPlanForDomainChange()
    : reloadPlanForPoolChange(app.phpService);

  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: nextApp },
      updatedAt: now,
    },
    preservedPath,
    reloadPlan,
  };
}

export type TemplateDrift = {
  slug: string;
  kind: TemplateKind;
  sourcePath: string;
  recordedUpstreamDigest: string;
  currentUpstreamDigest: string;
  drifted: boolean;
};

/**
 * Detect upstream template drift vs the digest recorded at custom activation.
 */
export async function detectTemplateDrift(
  platform: Platform,
  state: DesiredState,
  slug?: string,
): Promise<TemplateDrift[]> {
  const apps = slug ? [state.apps[slug]].filter(Boolean) : Object.values(state.apps);

  const out: TemplateDrift[] = [];
  for (const app of apps) {
    if (!app) continue;
    for (const kind of ["vhost", "pool"] as TemplateKind[]) {
      const prov = kind === "vhost" ? app.vhostTemplate : app.poolTemplate;
      if (prov.kind !== "custom") continue;
      const recorded = prov.copiedFromVersion ?? "";
      const { digest: current } = await upstreamTemplateDigest(platform, kind);
      out.push({
        slug: app.slug,
        kind,
        sourcePath: prov.sourcePath,
        recordedUpstreamDigest: recorded,
        currentUpstreamDigest: current,
        drifted: recorded !== "" && recorded !== current,
      });
    }
  }
  return out;
}

/** Human-readable drift warnings for status/apply. */
export function formatDriftWarnings(drifts: TemplateDrift[]): string[] {
  return drifts
    .filter((d) => d.drifted)
    .map(
      (d) =>
        `upstream ${d.kind} template drifted for app ${d.slug} (custom source preserved at ${d.sourcePath})`,
    );
}

/** Ensure parent of a path exists (for tests / copy targets). */
export async function ensureParentDir(platform: Platform, path: string): Promise<void> {
  await platform.fs.mkdirp(dirname(path), 0o755);
}
