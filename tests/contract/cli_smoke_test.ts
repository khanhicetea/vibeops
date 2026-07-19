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

    // Phase G: app/proxy teardown blocked
    assertEquals((await runCli([...base, "app", "delete", "demo"])) !== 0, true);
    assertEquals((await runCli([...base, "app", "remove", "demo"])) !== 0, true);

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
        "--upstream",
        "http://127.0.0.1:3001",
      ]),
      0,
    );
    const proxyVhost = await Deno.readTextFile(
      join(stack, "generated/nginx/sites/proxy-api.conf"),
    );
    assertEquals(proxyVhost.includes("upstream upstream_api {"), true);
    assertEquals(proxyVhost.includes("server 127.0.0.1:3000;"), true);
    assertEquals(proxyVhost.includes("server 127.0.0.1:3001;"), true);
    assertEquals(proxyVhost.includes("keepalive 5;"), true);
    assertEquals((await runCli([...base, "proxy", "delete", "api"])) !== 0, true);
    assertEquals((await runCli([...base, "proxy", "remove", "api"])) !== 0, true);
    // proxy still listed after blocked delete
    assertEquals(await runCli([...base, "proxy", "list"]), 0);

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
        "cron",
        "edit",
        "demo",
        "tick",
        "--schedule",
        "0 * * * *",
        "--cmd",
        "php artisan schedule:run >> logs/scheduler.log",
        "--no-apply",
      ]),
      0,
    );
    const cronState = JSON.parse(await Deno.readTextFile(join(stack, "state.json")));
    assertEquals(cronState.cronJobs[0].schedule, "0 * * * *");
    assertEquals(cronState.cronJobs[0].timezone, "UTC");
    assertEquals(cronState.cronJobs[0].commandMode, "shell");

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

    // compose wrapper materializes assets and renders before assembling argv
    assertEquals(
      await runCli([...base, "compose", "--print", "--", "build", "php85"]),
      0,
    );
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
    await Deno.mkdir(join(stack, "logs", "nginx"), { recursive: true });
    await Deno.writeTextFile(join(stack, "logs", "nginx", "demo.access.log"), "request\n");
    assertEquals(
      await runCli([...base, "logs", "access", "report", "--app", "demo", "--dry-run"]),
      0,
    );
    assertEquals(
      await runCli([
        ...base,
        "logs",
        "access",
        "report",
        "--app",
        "demo",
        "--attach",
        "--dry-run",
      ]),
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

    // App CLI shell / exec --print (profile-gated php*-cli; no live attach)
    assertEquals(
      await runCli([...base, "app", "shell", "demo", "--print"]),
      0,
    );
    assertEquals(
      await runCli([...base, "exec", "demo", "--print", "--", "php", "-v"]),
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

Deno.test("cli tls set + permissions + backup/restore dry paths", async () => {
  await withStack(async (stack) => {
    const base = ["--stack", stack, "--repo-root", Deno.cwd()];
    assertEquals(await runCli([...base, "init"]), 0);
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

    // TLS boot -> acme (no cert files needed for acme mode recording)
    assertEquals(
      await runCli([
        ...base,
        "tls",
        "set",
        "--app",
        "demo",
        "--mode",
        "acme",
        "--no-apply",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "apply", "--render-only", "--skip-validate"]), 0);
    const acmeVhost = await Deno.readTextFile(join(stack, "generated/nginx/sites/demo.conf"));
    const acmeMain = await Deno.readTextFile(join(stack, "generated/nginx/nginx.conf"));
    const acmeSsl = await Deno.readTextFile(join(stack, "generated/nginx/snippets/acme-ssl.conf"));
    assertEquals(acmeVhost.includes("acme-challenge"), false);
    assertEquals(acmeVhost.includes("return 301 https://"), true);
    assertEquals(acmeMain.includes("acme_issuer bento_acme"), true);
    assertEquals(acmeSsl.includes("acme_certificate bento_acme;"), true);

    // TLS external requires cert+key; missing paths fail closed
    assertEquals(
      (await runCli([
        ...base,
        "tls",
        "set",
        "--app",
        "demo",
        "--mode",
        "external",
        "--cert",
        "missing.crt",
        "--key",
        "missing.key",
        "--no-apply",
      ])) !== 0,
      true,
    );

    // External with valid restricted key
    const certs = join(stack, "certs");
    await Deno.mkdir(certs, { recursive: true });
    const cert = join(certs, "demo.crt");
    const key = join(certs, "demo.key");
    await Deno.writeTextFile(cert, "CERT\n");
    await Deno.writeTextFile(key, "KEY\n");
    await Deno.chmod(key, 0o600);
    assertEquals(
      await runCli([
        ...base,
        "tls",
        "set",
        "--app",
        "demo",
        "--mode",
        "external",
        "--cert",
        "demo.crt",
        "--key",
        "demo.key",
        "--no-apply",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "apply", "--render-only", "--skip-validate"]), 0);
    const extVhost = await Deno.readTextFile(join(stack, "generated/nginx/sites/demo.conf"));
    assertEquals(extVhost.includes("return 301 https://"), true);
    assertEquals(extVhost.includes("boot-ssl.conf"), false);

    // Permissions check / dry-run repair (no root required)
    assertEquals(await runCli([...base, "permissions", "check", "demo"]), 0);
    assertEquals(
      await runCli([...base, "permissions", "repair", "demo", "--dry-run"]),
      0,
    );
    assertEquals(
      await runCli([...base, "permissions", "repair", "demo", "--shallow"]),
      0,
    );

    // Backup uses the generated in-container root option file; no shell export is required.
    const prev = Deno.env.get("MYSQL_ROOT_PASSWORD");
    Deno.env.delete("MYSQL_ROOT_PASSWORD");
    try {
      // demo has no databases recorded, so this completes without invoking Docker.
      assertEquals(await runCli([...base, "backup", "--app", "demo", "--none"]), 0);

      // Restore missing file fails before docker.
      assertEquals(
        (await runCli([
          ...base,
          "restore",
          "--file",
          join(stack, "no-such.sql"),
          "--app",
          "demo",
          "--target",
          "demo",
        ])) !== 0,
        true,
      );
      // Replace confirmation mismatch fails closed.
      const dump = join(stack, "empty.sql");
      await Deno.writeTextFile(dump, "-- empty\n");
      assertEquals(
        (await runCli([
          ...base,
          "restore",
          "--file",
          dump,
          "--app",
          "demo",
          "--target",
          "demo",
          "--replace",
          "wrong",
        ])) !== 0,
        true,
      );
    } finally {
      if (prev !== undefined) Deno.env.set("MYSQL_ROOT_PASSWORD", prev);
    }

    // Legacy routing via CLI
    assertEquals(
      await runCli([
        ...base,
        "app",
        "create",
        "legacy",
        "--domain",
        "legacy.test",
        "--legacy",
        "--docroot",
        "htdocs",
        "--no-apply",
      ]),
      0,
    );
    assertEquals(await runCli([...base, "apply", "--render-only", "--skip-validate"]), 0);
    const legacyVhost = await Deno.readTextFile(
      join(stack, "generated/nginx/sites/legacy.conf"),
    );
    assertEquals(legacyVhost.includes("if ($uri !~ ^/index\\.php$)"), false);
    assertEquals(legacyVhost.includes("try_files $uri =404;"), true);
  });
});
