/**
 * Permission check / dry-run / shallow / recursive repair workflows.
 * Does not follow symlink targets. Startup must not recursively rewrite large trees.
 *
 * Policy (shared socket/read group = 1500 / bento-web):
 * - App home + code path: owner app, world-traverse (o+x) so Nginx can reach the public tree
 * - Public document tree: owner app, group bento-web, group-readable
 * - Private dirs (credentials, .ssh, .composer, .bento, logs, tmp): owner-only (or 750 for logs/tmp)
 */

import { join } from "@std/path";
import type { AppState, DesiredState } from "../domain/state.ts";
import { notFoundError } from "../domain/errors.ts";
import type { Platform } from "../platform/mod.ts";

function requireApp(state: DesiredState, slug: string): AppState {
  const app = state.apps[slug];
  if (!app) throw notFoundError(`app not found: ${slug}`);
  return app;
}

/** Shared Nginx / FPM socket group (must match pool listen.group and nginx image). */
export const BENTO_WEB_GID = 1500;

export type PermIssue = {
  path: string;
  issue: string;
  fix?: string;
};

export type PermReport = {
  app: string;
  issues: PermIssue[];
  checked: number;
};

const PRIVATE_DIRS = [
  "credentials",
  ".ssh",
  ".composer",
  ".bento",
  "logs",
  "tmp",
];

export async function checkPermissions(
  platform: Platform,
  state: DesiredState,
  slug: string,
  opts: { recursive?: boolean } = {},
): Promise<PermReport> {
  const app = requireApp(state, slug);
  const home = platform.paths.appHome(app.slug);
  const issues: PermIssue[] = [];
  let checked = 0;

  if (!(await platform.fs.exists(home))) {
    return {
      app: slug,
      issues: [{ path: home, issue: "app home missing", fix: "re-run app provision" }],
      checked: 0,
    };
  }

  const checkPath = async (
    path: string,
    expect: { private?: boolean; worldTraverse?: boolean },
  ) => {
    checked++;
    if (!(await platform.fs.exists(path))) {
      issues.push({ path, issue: "missing", fix: "create directory" });
      return;
    }
    try {
      const st = await platform.fs.stat(path);
      const mode = st.mode & 0o777;
      if (expect.private && (mode & 0o077) !== 0) {
        issues.push({
          path,
          issue: `mode ${mode.toString(8)} is group/world accessible`,
          fix: `chmod 700 or 750 as appropriate`,
        });
      }
      if (expect.worldTraverse && (mode & 0o001) === 0) {
        issues.push({
          path,
          issue: `mode ${
            mode.toString(8)
          } is not world-traversable (nginx cannot reach public tree)`,
          fix: `chmod 751 ${path}`,
        });
      }
    } catch (e) {
      issues.push({
        path,
        issue: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await checkPath(home, { worldTraverse: true });
  await checkPath(join(home, "code"), { worldTraverse: true });
  for (const d of PRIVATE_DIRS) {
    // logs/tmp may be 750; credentials/ssh/composer/bento should be 700
    const strict = d !== "logs" && d !== "tmp";
    await checkPath(join(home, d), { private: strict });
  }

  // Public document tree should exist
  const doc = join(home, "code", app.documentRoot || ".");
  await checkPath(doc, {});

  if (opts.recursive) {
    await walkLimited(platform, join(home, "code"), 5000, async (p) => {
      checked++;
      try {
        await platform.fs.stat(p);
      } catch {
        issues.push({ path: p, issue: "unreadable (possible broken symlink)" });
      }
    });
  }

  // identity meta
  const idPath = join(home, ".bento", "identity.json");
  if (await platform.fs.exists(idPath)) {
    try {
      const id = JSON.parse(await platform.fs.readText(idPath)) as {
        uid?: number;
        gid?: number;
      };
      if (id.uid !== app.uid || id.gid !== app.gid) {
        issues.push({
          path: idPath,
          issue:
            `identity meta uid/gid mismatch (meta ${id.uid}:${id.gid} vs state ${app.uid}:${app.gid})`,
          fix: "run permissions repair",
        });
      }
    } catch {
      issues.push({ path: idPath, issue: "invalid identity.json" });
    }
  } else {
    issues.push({
      path: idPath,
      issue: "missing identity metadata",
      fix: "run permissions repair --shallow",
    });
  }

  return { app: slug, issues, checked };
}

/**
 * Apply the product permission policy for an app home.
 * Used by app provision (initial) and `permissions repair`.
 */
export async function applyAppPermissionPolicy(
  platform: Platform,
  app: AppState,
  opts: { recursive?: boolean } = {},
): Promise<string[]> {
  const home = platform.paths.appHome(app.slug);
  const actions: string[] = [];
  const uid = Number(app.uid);
  const gid = Number(app.gid);
  const docRel = app.documentRoot && app.documentRoot !== "." ? app.documentRoot : "";
  const docRoot = docRel ? join(home, "code", docRel) : join(home, "code");

  const ensureDir = async (path: string, mode: number) => {
    if (!(await platform.fs.exists(path))) {
      await platform.fs.mkdirp(path, mode);
      actions.push(`created ${path}`);
    }
  };

  await ensureDir(home, 0o751);
  await ensureDir(join(home, "code"), 0o751);
  await ensureDir(join(home, "logs"), 0o750);
  await ensureDir(join(home, "tmp"), 0o750);
  await ensureDir(join(home, "tmp", "sessions"), 0o700);
  await ensureDir(join(home, ".bento"), 0o700);
  await ensureDir(join(home, ".ssh"), 0o700);
  await ensureDir(join(home, ".composer"), 0o700);
  await ensureDir(join(home, "credentials"), 0o700);
  await ensureDir(docRoot, 0o750);

  await platform.fs.atomicWriteText(
    join(home, ".bento", "identity.json"),
    `${JSON.stringify({ uid, gid, slug: app.slug, webGid: BENTO_WEB_GID }, null, 2)}\n`,
    0o640,
  );
  actions.push("wrote identity metadata");

  // Path components nginx must traverse (world +x; still no world read).
  for (const p of [home, join(home, "code")]) {
    try {
      await platform.fs.chmod(p, 0o751);
      actions.push(`chmod 751 ${p}`);
    } catch {
      actions.push(`skip chmod ${p}`);
    }
  }

  // Private dirs
  for (const d of PRIVATE_DIRS) {
    const p = join(home, d);
    if (!(await platform.fs.exists(p))) continue;
    const mode = d === "logs" || d === "tmp" ? 0o750 : 0o700;
    try {
      await platform.fs.chmod(p, mode);
      actions.push(`chmod ${mode.toString(8)} ${p}`);
    } catch {
      actions.push(`skip chmod ${p}`);
    }
  }

  // Public document root: group-readable by bento-web
  if (await platform.fs.exists(docRoot)) {
    try {
      await platform.fs.chmod(docRoot, 0o750);
      actions.push(`chmod 750 ${docRoot}`);
    } catch {
      actions.push(`skip chmod ${docRoot}`);
    }
  }

  // Ownership via host chown (best-effort; needs root/CAP_CHOWN)
  const chown = async (path: string, owner: string, recursive = false) => {
    const args = ["chown", ...(recursive ? ["-R"] : []), owner, path];
    const r = await platform.process.run(args, { timeoutMs: 10_000 }).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: String(e),
    }));
    if (r.code === 0) {
      actions.push(`chown ${owner} ${recursive ? "-R " : ""}${path}`);
    } else {
      actions.push(
        `skip chown ${path}: ${(r.stderr || r.stdout || "failed").trim().slice(0, 120)}`,
      );
    }
  };

  // App owns the home tree
  await chown(home, `${uid}:${gid}`, opts.recursive === true);
  if (!opts.recursive) {
    // Shallow: still chown core leaves
    for (
      const p of [
        home,
        join(home, "code"),
        join(home, "logs"),
        join(home, "tmp"),
        join(home, "tmp", "sessions"),
        join(home, ".bento"),
        join(home, ".ssh"),
        join(home, ".composer"),
        join(home, "credentials"),
        docRoot,
      ]
    ) {
      if (await platform.fs.exists(p)) await chown(p, `${uid}:${gid}`, false);
    }
  }

  // Public tree group = bento-web so nginx can read; path still app-owned.
  // Recursive chown of the public tree is intentional and bounded; walk never follows symlinks.
  if (await platform.fs.exists(docRoot)) {
    // Only recursive-chown the public tree when operator requested recursive repair.
    // Initial provision uses recursive=true while the tree is still small.
    await chown(docRoot, `${uid}:${BENTO_WEB_GID}`, opts.recursive === true);
    if (opts.recursive !== true) {
      await chown(docRoot, `${uid}:${BENTO_WEB_GID}`, false);
    }
    // Ensure dirs 750 / files 640 under public tree (bounded; no symlink follow)
    await walkLimited(platform, docRoot, 5000, async (p) => {
      try {
        const st = await platform.fs.lstat(p);
        if (st.isSymlink) return; // never chmod/chown through a symlink
        if (st.isDirectory) await platform.fs.chmod(p, 0o750);
        else if (st.isFile) await platform.fs.chmod(p, 0o640);
      } catch {
        // ignore
      }
    });
    actions.push(`public tree group ${BENTO_WEB_GID} under ${docRoot}`);
  }

  // Re-apply world-traverse after chown (chown doesn't change mode, but be explicit)
  for (const p of [home, join(home, "code")]) {
    try {
      await platform.fs.chmod(p, 0o751);
    } catch {
      // ignore
    }
  }

  await platform.fs.atomicWriteText(
    join(home, ".bento", "permission-policy.json"),
    `${
      JSON.stringify(
        {
          uid,
          gid,
          publicGroup: BENTO_WEB_GID,
          recursive: opts.recursive === true,
          updatedAt: platform.clock.nowIso(),
        },
        null,
        2,
      )
    }\n`,
    0o640,
  );
  actions.push("wrote permission-policy metadata");

  // Atomic control-plane rewrites create new inodes. Re-assert ownership on the
  // app-readable runtime files after all writes so the privilege-dropped runner can drain.
  for (
    const p of [
      join(home, "credentials", "app.env"),
      join(home, ".bento", "deploy.sh"),
      join(home, ".bento", "deploy.json"),
      join(home, ".bento", "queue.json"),
      join(home, ".bento", "identity.json"),
      join(home, ".bento", "permission-policy.json"),
    ]
  ) {
    if (await platform.fs.exists(p)) await chown(p, `${uid}:${gid}`, false);
  }

  return actions;
}

export async function repairPermissions(
  platform: Platform,
  state: DesiredState,
  slug: string,
  opts: { dryRun?: boolean; recursive?: boolean; shallow?: boolean } = {},
): Promise<{ report: PermReport; actions: string[] }> {
  const app = requireApp(state, slug);
  const report = await checkPermissions(platform, state, slug, {
    recursive: opts.recursive,
  });

  if (opts.dryRun) {
    const actions = report.issues.map(
      (issue) => `DRY-RUN would fix: ${issue.path} (${issue.issue})`,
    );
    return { report, actions };
  }

  const actions = await applyAppPermissionPolicy(platform, app, {
    recursive: opts.recursive === true && opts.shallow !== true,
  });

  const after = await checkPermissions(platform, state, slug, {
    recursive: opts.recursive,
  });
  return { report: after, actions };
}

/**
 * Bounded depth-first walk that never follows symlink targets.
 * Symlinks are visited (so broken links can be reported) but not descended into.
 */
async function walkLimited(
  platform: Platform,
  root: string,
  limit: number,
  visit: (path: string) => Promise<void>,
): Promise<void> {
  let count = 0;
  const stack = [root];
  while (stack.length && count < limit) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await platform.fs.readDir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (count >= limit) break;
      const p = join(dir, name);
      count++;
      await visit(p);
      try {
        // lstat: do not follow symlink targets (product §6.9 / E4).
        const st = await platform.fs.lstat(p);
        if (st.isDirectory && !st.isSymlink) stack.push(p);
      } catch {
        // skip unreadable entries
      }
    }
  }
}

export function formatPermReport(report: PermReport): string {
  const lines = [
    `Permissions for ${report.app}: checked=${report.checked} issues=${report.issues.length}`,
  ];
  for (const i of report.issues) {
    lines.push(`  - ${i.path}: ${i.issue}${i.fix ? ` [${i.fix}]` : ""}`);
  }
  return lines.join("\n") + "\n";
}

void (null as unknown as AppState);
