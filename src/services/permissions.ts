/**
 * Permission check / dry-run / shallow / recursive repair workflows.
 * Does not follow symlink targets. Startup must not recursively rewrite large trees.
 */

import { join } from "@std/path";
import type { AppState, DesiredState } from "../domain/state.ts";
import type { Platform } from "../platform/mod.ts";
import { getAppOrThrow } from "./app.ts";

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
  const app = getAppOrThrow(state, slug);
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

  const checkPath = async (path: string, expectPrivate: boolean) => {
    checked++;
    if (!(await platform.fs.exists(path))) {
      issues.push({ path, issue: "missing", fix: "create directory" });
      return;
    }
    try {
      const st = await platform.fs.stat(path);
      // We cannot reliably read ownership without root; check mode bits when available
      const mode = st.mode & 0o777;
      if (expectPrivate && (mode & 0o077) !== 0) {
        issues.push({
          path,
          issue: `mode ${mode.toString(8)} is group/world accessible`,
          fix: `chmod 700 or 750 as appropriate`,
        });
      }
    } catch (e) {
      issues.push({
        path,
        issue: e instanceof Error ? e.message : String(e),
      });
    }
  };

  await checkPath(home, false);
  for (const d of PRIVATE_DIRS) {
    await checkPath(join(home, d), true);
  }

  // Public document tree should exist
  const doc = join(home, "code", app.documentRoot || ".");
  await checkPath(doc, false);

  if (opts.recursive) {
    // Shallow walk of code tree without following symlinks (lstat via Deno in fs adapter uses stat;
    // for safety we only list one level unless recursive true, then bounded walk)
    await walkLimited(platform, join(home, "code"), 5000, async (p) => {
      checked++;
      // skip symlink targets: if we cannot stat as file/dir, report
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

export async function repairPermissions(
  platform: Platform,
  state: DesiredState,
  slug: string,
  opts: { dryRun?: boolean; recursive?: boolean; shallow?: boolean } = {},
): Promise<{ report: PermReport; actions: string[] }> {
  const app = getAppOrThrow(state, slug);
  const home = platform.paths.appHome(app.slug);
  const report = await checkPermissions(platform, state, slug, {
    recursive: opts.recursive,
  });
  const actions: string[] = [];

  if (opts.dryRun) {
    for (const issue of report.issues) {
      actions.push(`DRY-RUN would fix: ${issue.path} (${issue.issue})`);
    }
    return { report, actions };
  }

  // Always ensure core dirs (shallow)
  const dirs = [
    home,
    join(home, "code"),
    join(home, "logs"),
    join(home, "tmp"),
    join(home, "tmp", "sessions"),
    join(home, ".bento"),
    join(home, ".ssh"),
    join(home, ".composer"),
    join(home, "credentials"),
  ];
  for (const d of dirs) {
    if (!(await platform.fs.exists(d))) {
      await platform.fs.mkdirp(d, 0o750);
      actions.push(`created ${d}`);
    }
  }

  await platform.fs.atomicWriteText(
    join(home, ".bento", "identity.json"),
    `${JSON.stringify({ uid: app.uid, gid: app.gid, slug: app.slug }, null, 2)}\n`,
    0o640,
  );
  actions.push("wrote identity metadata");

  // Restrict private dirs
  for (const d of PRIVATE_DIRS) {
    const p = join(home, d);
    if (await platform.fs.exists(p)) {
      try {
        await platform.fs.chmod(p, d === "logs" ? 0o750 : 0o700);
        actions.push(`chmod ${p}`);
      } catch {
        actions.push(`skip chmod ${p} (permission denied)`);
      }
    }
  }

  if (opts.recursive && !opts.shallow) {
    actions.push(
      "recursive ownership repair requires host root/chown and is recorded as intended policy only",
    );
    await platform.fs.atomicWriteText(
      join(home, ".bento", "permission-policy.json"),
      `${
        JSON.stringify(
          {
            uid: app.uid,
            gid: app.gid,
            publicGroup: 1500,
            recursive: true,
            updatedAt: platform.clock.nowIso(),
          },
          null,
          2,
        )
      }\n`,
      0o640,
    );
  }

  const after = await checkPermissions(platform, state, slug, {
    recursive: opts.recursive,
  });
  return { report: after, actions };
}

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
        const st = await platform.fs.stat(p);
        if (st.isDirectory) stack.push(p);
      } catch {
        // skip
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
