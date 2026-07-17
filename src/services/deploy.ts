/**
 * Webhook deployment queue: auth verification, flocked queue, drain, OPcache cleanup.
 */

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { AppState, DesiredState, QueuePolicy } from "../domain/state.ts";
import {
  asDeployJobId,
  DEPLOY_DEFAULT_TIMEOUT_SEC,
  DEPLOY_GRACE_SEC,
  DEPLOY_MAX_BODY_BYTES,
  DEPLOY_MAX_QUEUED,
  DEPLOY_RETENTION,
  type DeployJobId,
} from "../domain/types.ts";
import { conflictError, notFoundError, safetyError, validationError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";
import type { ReloadPlan } from "../domain/reload.ts";

export type DeployJobStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export type DeployJob = {
  id: DeployJobId;
  status: DeployJobStatus;
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  logName?: string;
  deliveryId?: string;
  contentType?: string;
  payloadHash?: string;
  payloadPreview?: string;
};

export type DeployQueue = {
  schemaVersion: 1;
  jobs: DeployJob[];
};

export type EnableDeployInput = {
  slug: string;
  queuePolicy?: QueuePolicy;
  timeoutSec?: number;
  workdir?: string;
  argv?: string[];
};

/** Enabling/disabling deploy changes the vhost, FPM open_basedir, and runner cron. */
function deploySurfaceReloadPlan(app: AppState): ReloadPlan {
  return {
    nginx: true,
    phpFpm: new Set([app.phpService]),
    phpRunner: new Set([`${app.phpService}-runner`]),
  };
}

export function enableDeploy(
  state: DesiredState,
  input: EnableDeployInput,
  platform: Platform,
): { state: DesiredState; secret: string; reloadPlan: ReloadPlan } {
  const app = state.apps[input.slug];
  if (!app) throw notFoundError(`app not found: ${input.slug}`);

  const secret = platform.random.hex(32);
  const workdir = platform.paths.assertInsideHome(
    app.home,
    input.workdir ?? app.deploy.workdir ?? app.home,
  );
  const next: AppState = {
    ...app,
    deploy: {
      enabled: true,
      hmacSecret: secret,
      queuePolicy: input.queuePolicy ?? app.deploy.queuePolicy ?? "latest",
      timeoutSec: input.timeoutSec ?? app.deploy.timeoutSec ?? DEPLOY_DEFAULT_TIMEOUT_SEC,
      workdir,
      argv: input.argv ?? app.deploy.argv ?? ["sh", `${app.home}/.bento/deploy.sh`],
    },
    updatedAt: platform.clock.nowIso(),
  };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [input.slug]: next },
      updatedAt: next.updatedAt,
    },
    secret,
    reloadPlan: deploySurfaceReloadPlan(app),
  };
}

export function disableDeploy(
  state: DesiredState,
  slug: string,
  now: string,
): { state: DesiredState; reloadPlan: ReloadPlan } {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  const next: AppState = {
    ...app,
    deploy: {
      ...app.deploy,
      enabled: false,
      hmacSecret: undefined,
    },
    updatedAt: now,
  };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: next },
      updatedAt: now,
    },
    reloadPlan: deploySurfaceReloadPlan(app),
  };
}

export function rotateDeploySecret(
  state: DesiredState,
  slug: string,
  platform: Platform,
): { state: DesiredState; secret: string; reloadPlan: ReloadPlan } {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  if (!app.deploy.enabled) {
    throw validationError(`deploy is not enabled for ${slug}`);
  }
  const secret = platform.random.hex(32);
  const next: AppState = {
    ...app,
    deploy: { ...app.deploy, hmacSecret: secret },
    updatedAt: platform.clock.nowIso(),
  };
  return {
    state: {
      ...state,
      apps: { ...state.apps, [slug]: next },
      updatedAt: next.updatedAt,
    },
    secret,
    // Only the generated FastCGI secret changes during rotation.
    reloadPlan: {
      nginx: true,
      phpFpm: new Set(),
      phpRunner: new Set(),
    },
  };
}

/** Constant-time HMAC verification for GitHub-compatible signatures. */
export async function verifyDeploySignature(
  rawBody: Uint8Array,
  secret: string,
  signatureHeader: string | null,
  legacyHeader: string | null,
): Promise<boolean> {
  const candidates: Array<{ alg: "sha256" | "sha1"; hex: string }> = [];
  for (const h of [signatureHeader, legacyHeader]) {
    if (!h) continue;
    const m = /^(sha256|sha1)=([0-9a-fA-F]+)$/.exec(h.trim());
    if (m) candidates.push({ alg: m[1] as "sha256" | "sha1", hex: m[2]!.toLowerCase() });
  }
  if (candidates.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // Also prepare sha1 key
  const keySha1 = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  for (const c of candidates) {
    const sig = await crypto.subtle.sign(
      "HMAC",
      c.alg === "sha256" ? key : keySha1,
      rawBody.slice(),
    );
    const hex = encodeHex(new Uint8Array(sig));
    if (constantTimeEqual(hex, c.hex)) return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) {
    ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return ok === 0;
}

export async function loadQueue(
  platform: Platform,
  appHomeHost: string,
): Promise<DeployQueue> {
  const path = join(appHomeHost, ".bento", "queue.json");
  const lockPath = join(appHomeHost, ".bento", "queue.lock");
  const release = await platform.lock.shared(lockPath);
  try {
    if (!(await platform.fs.exists(path))) {
      return { schemaVersion: 1, jobs: [] };
    }
    const text = await platform.fs.readText(path);
    const raw = JSON.parse(text) as DeployQueue;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.jobs)) {
      throw validationError("invalid deploy queue schema");
    }
    return raw;
  } finally {
    await release();
  }
}

export async function saveQueue(
  platform: Platform,
  appHomeHost: string,
  queue: DeployQueue,
): Promise<void> {
  const path = join(appHomeHost, ".bento", "queue.json");
  const lockPath = join(appHomeHost, ".bento", "queue.lock");
  const release = await platform.lock.exclusive(lockPath);
  try {
    await platform.fs.atomicWriteText(
      path,
      `${JSON.stringify(queue, null, 2)}\n`,
      0o600,
    );
  } finally {
    await release();
  }
}

export type EnqueueResult =
  | { ok: true; status: 202; body: { id: string; status: "queued" } }
  | { ok: false; status: 401 | 404 | 413 | 429; body: { error: string } };

/**
 * Enqueue a deploy job (called from webhook controller logic / tests).
 * Does not run deployment work.
 */
export async function enqueueDeploy(
  platform: Platform,
  app: AppState,
  appHomeHost: string,
  rawBody: Uint8Array,
  headers: {
    signature256?: string | null;
    signature?: string | null;
    deliveryId?: string;
    contentType?: string;
  },
): Promise<EnqueueResult> {
  if (!app.deploy.enabled || !app.deploy.hmacSecret) {
    return { ok: false, status: 404, body: { error: "not found" } };
  }
  if (rawBody.byteLength > DEPLOY_MAX_BODY_BYTES) {
    return { ok: false, status: 413, body: { error: "payload too large" } };
  }
  const valid = await verifyDeploySignature(
    rawBody,
    app.deploy.hmacSecret,
    headers.signature256 ?? null,
    headers.signature ?? null,
  );
  if (!valid) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }

  const lockPath = join(appHomeHost, ".bento", "queue.lock");
  const release = await platform.lock.exclusive(lockPath);
  try {
    const path = join(appHomeHost, ".bento", "queue.json");
    let queue: DeployQueue = { schemaVersion: 1, jobs: [] };
    if (await platform.fs.exists(path)) {
      queue = JSON.parse(await platform.fs.readText(path)) as DeployQueue;
    }

    const queued = queue.jobs.filter((j) => j.status === "queued");
    if (app.deploy.queuePolicy === "fifo" && queued.length >= DEPLOY_MAX_QUEUED) {
      return { ok: false, status: 429, body: { error: "queue full" } };
    }

    const id = asDeployJobId(platform.random.id("dep"));
    const hashBuf = await crypto.subtle.digest("SHA-256", rawBody.slice());
    const payloadHash = encodeHex(new Uint8Array(hashBuf));
    const preview = new TextDecoder().decode(rawBody.slice(0, 512));

    // latest policy: supersede older queued
    if (app.deploy.queuePolicy === "latest") {
      for (const j of queue.jobs) {
        if (j.status === "queued") {
          j.status = "failed";
          j.error = "superseded";
          j.finishedAt = platform.clock.nowIso();
        }
      }
    }

    const job: DeployJob = {
      id,
      status: "queued",
      receivedAt: platform.clock.nowIso(),
      deliveryId: headers.deliveryId,
      contentType: headers.contentType,
      payloadHash,
      payloadPreview: preview,
      logName: `deploy-${id}.log`,
    };
    queue.jobs.push(job);

    // Optional payload snapshot
    const payloadPath = join(appHomeHost, ".bento", `payload-${id}.json`);
    await platform.fs.atomicWriteBytes(payloadPath, rawBody, 0o600);

    queue.jobs = retainJobs(queue.jobs);
    await platform.fs.atomicWriteText(
      path,
      `${JSON.stringify(queue, null, 2)}\n`,
      0o600,
    );

    return { ok: true, status: 202, body: { id, status: "queued" } };
  } finally {
    await release();
  }
}

export function retainJobs(jobs: DeployJob[]): DeployJob[] {
  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const terminal = jobs
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .sort((a, b) => (b.finishedAt ?? b.receivedAt).localeCompare(a.finishedAt ?? a.receivedAt));
  const keptTerminal = terminal.slice(0, Math.max(0, DEPLOY_RETENTION - active.length));
  return [...active, ...keptTerminal];
}

/**
 * Single-flight drain: one oldest queued job, timeout, exit mapping, OPcache attempt.
 */
export async function drainDeploy(
  platform: Platform,
  app: AppState,
  appHomeHost: string,
  opts?: {
    runCommand?: (
      argv: string[],
      env: Record<string, string>,
      workdir: string,
      timeoutMs: number,
    ) => Promise<{ code: number; log: string }>;
    resetOpcache?: () => Promise<{ ok: boolean; detail: string }>;
  },
): Promise<DeployJob | null> {
  const lockPath = join(appHomeHost, ".bento", "deploy.lock");
  const release = await platform.lock.exclusive(lockPath);
  try {
    const path = join(appHomeHost, ".bento", "queue.json");
    const qLock = join(appHomeHost, ".bento", "queue.lock");
    const qRelease = await platform.lock.exclusive(qLock);
    let queue: DeployQueue;
    try {
      if (!(await platform.fs.exists(path))) return null;
      queue = JSON.parse(await platform.fs.readText(path)) as DeployQueue;

      // Reclaim stale running
      const now = Date.now();
      for (const j of queue.jobs) {
        if (j.status === "running" && j.startedAt) {
          const started = Date.parse(j.startedAt);
          const limit = (app.deploy.timeoutSec + DEPLOY_GRACE_SEC) * 1000;
          if (now - started > limit) {
            j.status = "failed";
            j.error = "interrupted";
            j.finishedAt = platform.clock.nowIso();
          }
        }
      }

      if (queue.jobs.some((j) => j.status === "running")) {
        await platform.fs.atomicWriteText(path, `${JSON.stringify(queue, null, 2)}\n`, 0o600);
        return null; // single-flight
      }

      const next = queue.jobs
        .filter((j) => j.status === "queued")
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))[0];
      if (!next) {
        await platform.fs.atomicWriteText(path, `${JSON.stringify(queue, null, 2)}\n`, 0o600);
        return null;
      }

      next.status = "running";
      next.startedAt = platform.clock.nowIso();
      await platform.fs.atomicWriteText(path, `${JSON.stringify(queue, null, 2)}\n`, 0o600);
    } finally {
      await qRelease();
    }

    const job = queue.jobs.find((j) => j.status === "running")!;
    const logName = job.logName ?? `deploy-${job.id}.log`;
    const logPath = join(appHomeHost, "logs", logName);
    await platform.fs.mkdirp(join(appHomeHost, "logs"));

    const payloadFile = join(appHomeHost, ".bento", `payload-${job.id}.json`);
    const env = {
      BENTO_APP: app.slug,
      BENTO_DEPLOY_ID: job.id,
      BENTO_DEPLOY_LOG: logPath,
      BENTO_DEPLOY_PAYLOAD_FILE: payloadFile,
      HOME: app.home,
    };

    let exitCode = 1;
    let log = "";
    try {
      // Validate workdir/script
      platform.paths.assertInsideHome(app.home, app.deploy.workdir);
      const runner = opts?.runCommand ?? (async (argv, e, wd, timeoutMs) => {
        const r = await platform.process.run(argv, {
          cwd: wd,
          env: e,
          timeoutMs,
        });
        return { code: r.code, log: r.stdout + r.stderr };
      });
      const result = await runner(
        app.deploy.argv,
        env,
        // Host path for local tests; production uses container home
        appHomeHost,
        app.deploy.timeoutSec * 1000,
      );
      exitCode = result.code;
      log = result.log;
    } catch (cause) {
      exitCode = 1;
      log = cause instanceof Error ? cause.message : String(cause);
      job.error = "execution error";
    }

    await platform.fs.appendText(logPath, log + "\n");

    // Map exit codes
    if (exitCode === 0) job.status = "success";
    else if (exitCode === 99) job.status = "skipped";
    else {
      job.status = "failed";
      job.error = job.error ?? `exit ${exitCode}`;
    }
    job.exitCode = exitCode;
    job.finishedAt = platform.clock.nowIso();

    // OPcache reset attempt — failure must not rewrite terminal result
    const reset = opts?.resetOpcache ?? (async () => ({ ok: true, detail: "noop" }));
    try {
      const r = await reset();
      if (!r.ok) {
        await platform.fs.appendText(
          logPath,
          `opcache reset failed: ${r.detail}\n`,
        );
      } else {
        await platform.fs.appendText(logPath, `opcache reset: ${r.detail}\n`);
      }
    } catch (cause) {
      await platform.fs.appendText(
        logPath,
        `opcache reset error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }

    // Cleanup payload snapshot
    await platform.fs.remove(payloadFile).catch(() => {});

    // Persist terminal state + retention
    const qRelease2 = await platform.lock.exclusive(qLock);
    try {
      const latest = JSON.parse(await platform.fs.readText(path)) as DeployQueue;
      const idx = latest.jobs.findIndex((j) => j.id === job.id);
      if (idx >= 0) latest.jobs[idx] = job;
      latest.jobs = retainJobs(latest.jobs);
      // prune old logs
      await pruneDeployLogs(platform, appHomeHost, latest.jobs);
      await platform.fs.atomicWriteText(
        path,
        `${JSON.stringify(latest, null, 2)}\n`,
        0o600,
      );
    } finally {
      await qRelease2();
    }

    return job;
  } finally {
    await release();
  }
}

async function pruneDeployLogs(
  platform: Platform,
  appHomeHost: string,
  jobs: DeployJob[],
): Promise<void> {
  const logsDir = join(appHomeHost, "logs");
  if (!(await platform.fs.exists(logsDir))) return;
  const keep = new Set(
    jobs.map((j) => j.logName).filter((x): x is string => !!x),
  );
  const names = await platform.fs.readDir(logsDir);
  for (const n of names) {
    if (n.startsWith("deploy-") && n.endsWith(".log") && !keep.has(n)) {
      await platform.fs.remove(join(logsDir, n)).catch(() => {});
    }
  }
}

export function deployWebhookInstructions(app: AppState, secret: string): string {
  return [
    `Deploy webhook for app ${app.slug}`,
    `URL: https://${app.mainDomain}/_bento/deploy`,
    `Method: POST`,
    `Headers:`,
    `  X-Hub-Signature-256: sha256=<hmac>`,
    `  Content-Type: application/json`,
    `Secret: ${secret}`,
    `Body limit: ${DEPLOY_MAX_BODY_BYTES} bytes`,
    `Queue policy: ${app.deploy.queuePolicy}`,
    `Replace ${app.home}/.bento/deploy.sh (default exits 99/skipped).`,
    `Note: secret is stored in desired state only; not in app-writable secret files.`,
  ].join("\n");
}

// prevent unused import lint
void conflictError;
void safetyError;
