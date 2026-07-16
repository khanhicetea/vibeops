import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runCli } from "../../src/main.ts";

async function withStack(fn: (stack: string) => Promise<void>) {
  const stack = await Deno.makeTempDir({ prefix: "bento-cli-" });
  try {
    await fn(stack);
  } finally {
    await Deno.remove(stack, { recursive: true });
  }
}

Deno.test("cli init render status app create", async () => {
  await withStack(async (stack) => {
    const base = ["--stack", stack, "--repo-root", Deno.cwd()];
    assertEquals(await runCli([...base, "init"]), 0);
    assertEquals(await runCli([...base, "render"]), 0);
    assertEquals(await runCli([...base, "status"]), 0);
    assertEquals(
      await runCli([
        ...base,
        "app",
        "create",
        "demo",
        "--domain",
        "demo.test",
        "--db",
        "--no-apply",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "app", "list"]), 0);
    assertEquals(await runCli([...base, "render"]), 0);

    // generated app vhost exists
    const vhost = join(stack, "generated/nginx/sites/demo.conf");
    const text = await Deno.readTextFile(vhost);
    assertEquals(text.includes("demo.test"), true);
    assertEquals(text.includes("index.php"), true); // front-controller routes via index.php

    // domain collision
    const code = await runCli([
      ...base,
      "app",
      "create",
      "other",
      "--domain",
      "demo.test",
      "--no-apply",
    ]);
    assertEquals(code !== 0, true);

    // php add/remove
    assertEquals(await runCli([...base, "php", "add", "8.3"]), 0);
    assertEquals(await runCli([...base, "php", "list"]), 0);
    // cannot remove default
    assertEquals((await runCli([...base, "php", "remove", "8.5"])) !== 0, true);
    assertEquals(await runCli([...base, "php", "remove", "8.3"]), 0);

    // mysql remove blocked
    assertEquals((await runCli([...base, "mysql", "remove", "8.4"])) !== 0, true);

    // proxy
    assertEquals(
      await runCli([
        ...base,
        "proxy",
        "create",
        "api",
        "--domain",
        "api.test",
        "--upstream",
        "http://127.0.0.1:3000",
      ]),
      0,
    );

    // cron + worker
    assertEquals(
      await runCli([
        ...base,
        "cron",
        "add",
        "--app",
        "demo",
        "--name",
        "tick",
        "--schedule",
        "*/5 * * * *",
        "--",
        "php",
        "artisan",
        "schedule:run",
      ]),
      0,
    );
    assertEquals(
      await runCli([
        ...base,
        "worker",
        "add",
        "--app",
        "demo",
        "--name",
        "queue",
        "--",
        "php",
        "artisan",
        "queue:work",
      ]),
      0,
    );

    // deploy enable
    assertEquals(await runCli([...base, "deploy", "enable", "demo"]), 0);
    assertEquals(await runCli([...base, "deploy", "status", "demo"]), 0);

    // compose safety
    assertEquals(
      (await runCli([...base, "compose", "--", "down", "-v"])) !== 0,
      true,
    );

    // version
    assertEquals(await runCli([...base, "version"]), 0);

    // future state rejection
    const badState = JSON.parse(await Deno.readTextFile(join(stack, "state.json")));
    badState.schemaVersion = 999;
    await Deno.writeTextFile(join(stack, "state.json"), JSON.stringify(badState));
    assertEquals((await runCli([...base, "status"])) !== 0, true);
  });
});

Deno.test("invalid state is not overwritten on read", async () => {
  await withStack(async (stack) => {
    const base = ["--stack", stack, "--repo-root", Deno.cwd()];
    await runCli([...base, "init"]);
    const path = join(stack, "state.json");
    const original = "this is not json {{{";
    await Deno.writeTextFile(path, original);
    assertEquals((await runCli([...base, "status"])) !== 0, true);
    const after = await Deno.readTextFile(path);
    assertEquals(after, original);
  });
});
