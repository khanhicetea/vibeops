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
    // Without --db: best-effort MySQL may defer when the service is down.
    assertEquals(
      await runCli([
        ...base,
        "app",
        "create",
        "demo",
        "--domain",
        "demo.test",
        "--no-apply",
      ]),
      0,
    );
    // Explicit --db must fail closed when MySQL is unavailable (no database recorded).
    const dbFail = await runCli([
      ...base,
      "app",
      "create",
      "needsdb",
      "--domain",
      "needsdb.test",
      "--db",
      "--no-apply",
    ]);
    assertEquals(dbFail !== 0, true);
    assertEquals(await runCli([...base, "app", "list"]), 0);
    assertEquals(await runCli([...base, "render"]), 0);

    // Root client option file materializes real password from stack .env (mode 0600).
    const rootCnf = join(stack, "generated/mysql/mysql84/root.cnf");
    const cnfText = await Deno.readTextFile(rootCnf);
    assertEquals(cnfText.includes("password="), true);
    assertEquals(cnfText.includes("{{MYSQL_ROOT_PASSWORD}}"), false);
    const cnfStat = await Deno.stat(rootCnf);
    assertEquals((cnfStat.mode ?? 0) & 0o777, 0o600);

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

    // Phase B: worker control help surface + scoped inspect usage
    assertEquals(
      (await runCli([...base, "worker", "inspect", "missing", "x"])) !== 0,
      true,
    );

    // Phase B: access logs enable (nginx-only) + rotate + report dry-run
    assertEquals(
      await runCli([...base, "logs", "access", "enable", "--app", "demo", "--no-apply"]),
      0,
    );
    // vhost should include access_log after apply
    assertEquals(await runCli([...base, "apply", "--render-only", "--skip-validate"]), 0);
    const vhostLogged = await Deno.readTextFile(vhost);
    assertEquals(vhostLogged.includes("access_log"), true);
    assertEquals(
      await runCli([...base, "logs", "access", "rotate", "--app", "demo"]),
      0,
    );

    // Phase B: mysql shell --print keeps secrets off printed argv
    // (stack .env has MYSQL_ROOT_PASSWORD from init)
    assertEquals(
      await runCli([...base, "mysql", "shell", "--root", "--print"]),
      0,
    );
    assertEquals(
      await runCli([...base, "mysql", "shell", "--app", "demo", "--print"]),
      0,
    );

    // Phase B: template select / drift / return
    const customTpl = join(stack, "custom-vhost.tpl");
    await Deno.writeTextFile(customTpl, "# custom\nserver { listen 80; }\n");
    assertEquals(
      await runCli([
        ...base,
        "template",
        "select",
        "--app",
        "demo",
        "--kind",
        "vhost",
        "--source",
        customTpl,
        "--no-apply",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "template", "drift", "--app", "demo"]), 0);
    assertEquals(
      await runCli([
        ...base,
        "template",
        "return",
        "--app",
        "demo",
        "--kind",
        "vhost",
        "--no-apply",
      ]),
      0,
    );
    // custom source preserved under stack custom/
    const customCopied = join(stack, "custom/apps/demo/vhost/vhost.conf.tpl");
    assertEquals(await Deno.stat(customCopied).then(() => true).catch(() => false), true);

    // Phase B: maintenance run + apply --preview
    assertEquals(await runCli([...base, "maintenance", "run", "--retain-days", "14"]), 0);
    assertEquals(await runCli([...base, "apply", "--preview"]), 0);

    // Phase B: batched --no-apply then single apply
    assertEquals(
      await runCli([
        ...base,
        "worker",
        "add",
        "--app",
        "demo",
        "--name",
        "batch",
        "--no-apply",
        "--",
        "sleep",
        "60",
      ]),
      0,
    );
    assertEquals(
      await runCli([
        ...base,
        "cron",
        "add",
        "--app",
        "demo",
        "--name",
        "batch-tick",
        "--schedule",
        "0 * * * *",
        "--no-apply",
        "--",
        "true",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "apply", "--render-only", "--skip-validate"]), 0);

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
