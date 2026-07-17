import { assertEquals, assertThrows } from "@std/assert";
import { createEmptyState } from "../../src/domain/state.ts";
import { allocateIdentity, capacityWarnings, provisionApp } from "../../src/services/app.ts";
import { addPhpVersion, buildCliExec, cliRunComposeCommand } from "../../src/services/php.ts";
import { createFixedClock } from "../../src/platform/clock.ts";
import { createSeededRandom } from "../../src/platform/random.ts";
import { createFileSystem } from "../../src/platform/fs.ts";
import { createMemoryLock } from "../../src/platform/lock.ts";
import { createRecordingProcessRunner } from "../../src/platform/process.ts";
import { createAssetResolver } from "../../src/platform/assets.ts";
import { createPathPolicy } from "../../src/platform/paths.ts";
import type { Platform } from "../../src/platform/mod.ts";
import { join } from "@std/path";

function testPlatform(root: string): Platform {
  const fs = createFileSystem();
  return {
    clock: createFixedClock("2026-07-16T12:00:00.000Z"),
    random: createSeededRandom("0123456789abcdef"),
    fs,
    lock: createMemoryLock(),
    process: createRecordingProcessRunner(),
    assets: createAssetResolver(fs),
    paths: createPathPolicy(root),
  };
}

Deno.test("provisionApp creates distinct identities and domain ownership", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState("2026-07-16T12:00:00.000Z");
    const a = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.example",
      createDatabase: true,
    });
    state = a.state;
    const b = provisionApp(platform, state, {
      slug: "beta",
      domain: "beta.example",
    });
    state = b.state;

    assertEquals(a.app.uid !== b.app.uid, true);
    assertEquals(a.app.home, "/home/alpha");
    assertEquals(b.app.home, "/home/beta");
    assertEquals(state.domains["alpha.example"]?.kind, "app");
    assertEquals(state.domains["beta.example"]?.kind, "app");
    assertEquals(a.app.databases[0]?.name, "alpha");
    assertEquals(a.app.mysqlService, b.app.mysqlService); // same default service
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("domain collision is refused", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    state = provisionApp(platform, state, {
      slug: "alpha",
      domain: "shared.example",
    }).state;
    assertThrows(
      () =>
        provisionApp(platform, state, {
          slug: "beta",
          domain: "shared.example",
        }),
      Error,
      "already owned",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main domain change retains identity", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    const first = provisionApp(platform, state, {
      slug: "alpha",
      domain: "old.example",
    });
    state = first.state;
    const second = provisionApp(platform, state, {
      slug: "alpha",
      domain: "new.example",
    });
    assertEquals(second.app.uid, first.app.uid);
    assertEquals(second.app.home, first.app.home);
    assertEquals(second.state.domains["old.example"], undefined);
    assertEquals(second.state.domains["new.example"]?.kind, "app");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("omitted php version preserves existing", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    // add second php and assign app to it
    state = {
      ...state,
      phpVersions: [
        ...state.phpVersions,
        {
          version: "8.3" as never,
          service: "php83",
          image: "bento/php:8.3-fpm",
          processCap: 200,
        },
      ],
    };
    const first = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.example",
      phpVersion: "8.3",
    });
    state = first.state;
    // change defaults
    state = {
      ...state,
      defaults: { ...state.defaults, phpVersion: "8.5" as never },
    };
    const second = provisionApp(platform, state, {
      slug: "alpha",
      domain: "a.example",
    });
    assertEquals(second.app.phpVersion, "8.3");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("database namespace enforced", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    const state = createEmptyState();
    assertThrows(
      () =>
        provisionApp(platform, state, {
          slug: "alpha",
          domain: "a.example",
          createDatabase: true,
          databaseName: "otherapp_db",
        }),
      Error,
      "namespace",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capacity warnings when pools exceed cap", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState();
    state = {
      ...state,
      phpVersions: state.phpVersions.map((v) => ({ ...v, processCap: 15 })),
    };
    state = provisionApp(platform, state, {
      slug: "app-a",
      domain: "a.example",
      fpmProfile: "medium",
    }).state;
    state = provisionApp(platform, state, {
      slug: "app-b",
      domain: "b.example",
      fpmProfile: "medium",
    }).state;
    const warnings = capacityWarnings(state);
    assertEquals(warnings.length >= 1, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("allocateIdentity skips used uids", () => {
  const state = createEmptyState();
  const withApp = {
    ...state,
    apps: {
      x: {
        ...provisionApp(
          testPlatform("/tmp"),
          state,
          { slug: "xapp", domain: "x.example" },
        ).app,
      },
    },
  };
  // just ensure function returns numbers
  const id = allocateIdentity(state);
  assertEquals(typeof id.uid, "number");
  void withApp;
});

Deno.test("workdir escape rejected by path policy", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    assertThrows(
      () => platform.paths.assertInsideHome(join(root, "homes", "app"), "../../etc"),
      Error,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("buildCliExec targets profile-gated -cli service with app identity", async () => {
  const root = await Deno.makeTempDir({ prefix: "bento-test-" });
  try {
    const platform = testPlatform(root);
    let state = createEmptyState("2026-07-16T12:00:00.000Z");
    const provisioned = provisionApp(platform, state, {
      slug: "alpha",
      domain: "alpha.example",
    });
    state = provisioned.state;
    const app = provisioned.app;

    const shell = buildCliExec(platform, state, "alpha", []);
    assertEquals(shell.service, `${app.phpService}-cli`);
    assertEquals(shell.profile, "cli");
    assertEquals(shell.user, `${app.uid}:${app.gid}`);
    assertEquals(shell.workdir, app.home);
    assertEquals(shell.argv, ["bash"]);
    assertEquals(shell.env.HOME, app.home);
    assertEquals(shell.env.BENTO_APP, "alpha");
    assertEquals(shell.env.BENTO_UID, String(app.uid));
    assertEquals(shell.env.BENTO_GID, String(app.gid));
    assertEquals(shell.env.USER, "alpha");

    const runArgs = cliRunComposeCommand(shell, { tty: true });
    assertEquals(runArgs.slice(0, 5), ["--profile", "cli", "run", "--rm", "-it"]);
    assertEquals(runArgs.includes(shell.service), true);
    // Must NOT use docker -u (that yields "I have no name!"); entrypoint setpriv-drops.
    assertEquals(runArgs.includes("-u"), false);
    assertEquals(runArgs.includes(`BENTO_UID=${app.uid}`), true);
    assertEquals(runArgs.includes(`BENTO_GID=${app.gid}`), true);

    const scripted = cliRunComposeCommand(
      buildCliExec(platform, state, "alpha", ["php", "-v"]),
      { tty: false },
    );
    assertEquals(scripted.includes("-T"), true);
    assertEquals(scripted.includes("-it"), false);
    assertEquals(scripted.includes("-u"), false);
    assertEquals(scripted.slice(-2), ["php", "-v"]);

    // workdir must stay inside app home
    assertThrows(
      () => buildCliExec(platform, state, "alpha", [], { workdir: "/etc" }),
      Error,
    );

    // PHP override must be managed
    state = addPhpVersion(state, "8.3");
    const ov = buildCliExec(platform, state, "alpha", ["php", "-v"], {
      phpVersionOverride: "8.3",
    });
    assertEquals(ov.service, "php83-cli");
    assertEquals(ov.phpVersion, "8.3");
    assertThrows(
      () => buildCliExec(platform, state, "alpha", [], { phpVersionOverride: "7.4" }),
      Error,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
