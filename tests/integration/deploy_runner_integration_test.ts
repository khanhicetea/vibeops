/**
 * Live runner deploy pipeline using an actual PHP-FPM process and Unix socket.
 * Soft-skips only when Docker/the official PHP image is unavailable.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { isDockerAvailable } from "./helpers.ts";

async function runDocker(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, opts.timeoutMs);
  }
  try {
    const output = await child.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function hmacSha256(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

Deno.test({
  name: "live webhook -> queue -> runner hook -> FPM OPcache reset",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!(await isDockerAvailable())) {
      console.log("  [skip] Docker unavailable — live deploy pipeline skipped");
      return;
    }

    const image = "php:8.4-fpm";
    const inspect = await runDocker(["image", "inspect", image], { timeoutMs: 15_000 });
    if (inspect.code !== 0) {
      const pull = await runDocker(["pull", image], { timeoutMs: 180_000 });
      if (pull.code !== 0) {
        console.log(`  [skip] unable to pull ${image}: ${pull.stderr.trim().slice(0, 200)}`);
        return;
      }
    }

    const root = await Deno.makeTempDir({ prefix: "bento-live-deploy-" });
    const home = join(root, "home", "alpha");
    const bentoDir = join(home, ".bento");
    const logsDir = join(home, "logs");
    const socketDir = join(root, "run");
    const poolPath = join(root, "alpha-pool.conf");
    let container = "";
    try {
      await Deno.mkdir(bentoDir, { recursive: true, mode: 0o777 });
      await Deno.mkdir(logsDir, { recursive: true, mode: 0o777 });
      await Deno.mkdir(socketDir, { recursive: true, mode: 0o777 });
      // The container's www-data user owns runtime writes; permissive fixture
      // directories avoid requiring host root/chown in CI.
      await Deno.chmod(home, 0o777);
      await Deno.chmod(bentoDir, 0o777);
      await Deno.chmod(logsDir, 0o777);
      await Deno.chmod(socketDir, 0o777);

      await Deno.writeTextFile(
        poolPath,
        `[alpha]
user = www-data
group = www-data
listen = /run/php-fpm/php85/alpha.sock
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 2
`,
      );
      await Deno.writeTextFile(
        join(bentoDir, "deploy.json"),
        `${
          JSON.stringify({
            timeoutSec: 10,
            workdir: "/home/alpha",
            argv: ["sh", "/home/alpha/.bento/deploy.sh"],
            queuePolicy: "latest",
          })
        }\n`,
      );
      await Deno.writeTextFile(
        join(bentoDir, "deploy.sh"),
        `#!/bin/sh
set -eu
test -s "$BENTO_DEPLOY_PAYLOAD_FILE"
printf '%s\n' "$BENTO_DEPLOY_ID" > "$HOME/.bento/hook-ran"
echo "live hook executed: $BENTO_DEPLOY_ID"
`,
      );
      await Deno.chmod(join(bentoDir, "deploy.sh"), 0o755);
      // Let the webhook create queue.json as www-data, matching the real app
      // ownership model (the host test process cannot chown to container UIDs).
      await Deno.chmod(join(bentoDir, "deploy.json"), 0o666);

      const started = await runDocker([
        "run",
        "-d",
        "--rm",
        "-p",
        "127.0.0.1::8080",
        "-v",
        `${join(root, "home")}:/home`,
        "-v",
        `${join(Deno.cwd(), "templates", "helpers")}:/opt/bento/helpers:ro`,
        "-v",
        `${socketDir}:/run/php-fpm/php85`,
        "-v",
        `${poolPath}:/usr/local/etc/php-fpm.d/zz-alpha.conf:ro`,
        image,
      ], { timeoutMs: 30_000 });
      assertEquals(started.code, 0, started.stderr);
      container = started.stdout.trim();
      assertEquals(container.length > 0, true);

      const socketReady = await waitFor(async () => {
        try {
          return (await Deno.stat(join(socketDir, "alpha.sock"))).isSocket === true;
        } catch {
          return false;
        }
      });
      assertEquals(socketReady, true, "PHP-FPM app socket was not created");

      const secret = "live-integration-secret";
      const server = await runDocker([
        "exec",
        "-d",
        "-u",
        "www-data",
        "-e",
        "BENTO_APP=alpha",
        "-e",
        `BENTO_DEPLOY_SECRET=${secret}`,
        container,
        "php",
        "-d",
        "variables_order=EGPCS",
        "-S",
        "0.0.0.0:8080",
        "/opt/bento/helpers/deploy-webhook.php",
      ], { timeoutMs: 15_000 });
      assertEquals(server.code, 0, server.stderr);

      const portResult = await runDocker(["port", container, "8080/tcp"], {
        timeoutMs: 15_000,
      });
      assertEquals(portResult.code, 0, portResult.stderr);
      const match = /:(\d+)\s*$/.exec(portResult.stdout.trim());
      assertEquals(match !== null, true, `unexpected docker port: ${portResult.stdout}`);
      const webhookUrl = `http://127.0.0.1:${match![1]}/_bento/deploy`;
      const webReady = await waitFor(async () => {
        try {
          const response = await fetch(webhookUrl);
          return response.status === 404;
        } catch {
          return false;
        }
      });
      assertEquals(webReady, true, "PHP webhook server did not become ready");

      const body = JSON.stringify({ ref: "refs/heads/main", live: true });
      const signature = await hmacSha256(secret, body);
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body,
      });
      const responseText = await response.text();
      assertEquals(response.status, 202, responseText);
      const accepted = JSON.parse(responseText) as { id: string; status: string };
      assertEquals(accepted.status, "queued");

      let queue = JSON.parse(await Deno.readTextFile(join(bentoDir, "queue.json"))) as {
        jobs: Array<{ id: string; status: string; exitCode?: number; logName?: string }>;
      };
      assertEquals(queue.jobs.find((job) => job.id === accepted.id)?.status, "queued");

      // Use a separate ephemeral PHP container as the runner. It has no Bento
      // binary and sees the FPM socket directory read-only, matching Compose.
      const drained = await runDocker([
        "run",
        "--rm",
        "-u",
        "www-data",
        "--entrypoint",
        "sh",
        "-v",
        `${join(root, "home")}:/home`,
        "-v",
        `${join(Deno.cwd(), "templates", "helpers")}:/opt/bento/helpers:ro`,
        "-v",
        `${socketDir}:/run/php-fpm/php85:ro`,
        image,
        "/opt/bento/helpers/deploy-drain.sh",
        "alpha",
        "/run/php-fpm/php85/alpha.sock",
      ], { timeoutMs: 30_000 });
      assertEquals(drained.code, 0, drained.stderr + drained.stdout);
      assertEquals(drained.stdout.includes(`drained ${accepted.id} -> success`), true);

      queue = JSON.parse(await Deno.readTextFile(join(bentoDir, "queue.json")));
      const job = queue.jobs.find((candidate) => candidate.id === accepted.id);
      assertEquals(job?.status, "success");
      assertEquals(job?.exitCode, 0);
      assertEquals(
        (await Deno.readTextFile(join(bentoDir, "hook-ran"))).trim(),
        accepted.id,
      );
      const log = await Deno.readTextFile(
        join(logsDir, job?.logName ?? `deploy-${accepted.id}.log`),
      );
      assertEquals(log.includes("live hook executed"), true);
      assertEquals(log.includes("opcache reset: reset"), true);
      let payloadExists = true;
      try {
        await Deno.stat(join(bentoDir, `payload-${accepted.id}.json`));
      } catch {
        payloadExists = false;
      }
      assertEquals(payloadExists, false);
    } finally {
      if (container !== "") {
        await runDocker(["rm", "-f", container], { timeoutMs: 30_000 });
      }
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
