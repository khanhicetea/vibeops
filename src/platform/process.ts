import type { ProcessRunner, RunOptions, RunResult } from "./interfaces.ts";
import { platformError } from "../domain/errors.ts";

export function createProcessRunner(): ProcessRunner {
  return {
    async run(command: string[], options?: RunOptions): Promise<RunResult> {
      if (command.length === 0) {
        throw platformError("empty command");
      }
      const [cmd, ...args] = command;
      try {
        const proc = new Deno.Command(cmd!, {
          args,
          cwd: options?.cwd,
          env: options?.env,
          stdin: options?.stdin !== undefined ? "piped" : "null",
          stdout: "piped",
          stderr: "piped",
        });
        const child = proc.spawn();

        if (options?.stdin !== undefined) {
          const writer = child.stdin.getWriter();
          const data = typeof options.stdin === "string"
            ? new TextEncoder().encode(options.stdin)
            : options.stdin;
          await writer.write(data);
          await writer.close();
        }

        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (options?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // already exited
            }
          }, options.timeoutMs);
        }

        const output = await child.output();
        if (timer !== undefined) clearTimeout(timer);

        const result: RunResult = {
          code: timedOut ? 124 : output.code,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        };
        return result;
      } catch (cause) {
        throw platformError(`failed to run: ${command.join(" ")}`, cause);
      }
    },
  };
}

/** Recording process runner for tests. */
export function createRecordingProcessRunner(
  handler?: (command: string[], options?: RunOptions) => Promise<RunResult> | RunResult,
): ProcessRunner & { calls: Array<{ command: string[]; options?: RunOptions }> } {
  const calls: Array<{ command: string[]; options?: RunOptions }> = [];
  return {
    calls,
    async run(command: string[], options?: RunOptions): Promise<RunResult> {
      calls.push({ command, options });
      if (handler) return await handler(command, options);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}
