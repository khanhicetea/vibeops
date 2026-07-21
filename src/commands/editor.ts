import { isBentoError, platformError } from "../domain/errors.ts";

/** Open a file in the operator's editor and wait until it closes. */
export async function openEditor(path: string): Promise<void> {
  const editor = Deno.env.get("VISUAL")?.trim() || Deno.env.get("EDITOR")?.trim() || "vi";

  try {
    // Use a positional parameter for the path so spaces and shell characters in
    // the stack root cannot alter the command. The editor value intentionally
    // supports conventional values such as "code --wait".
    const child = new Deno.Command("sh", {
      args: ["-c", `exec ${editor} "$1"`, "bento-editor", path],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    if (!status.success) {
      throw platformError(`editor exited with status ${status.code}; template was not activated`);
    }
  } catch (cause) {
    if (isBentoError(cause)) throw cause;
    throw platformError(`failed to open editor for ${path}`, cause);
  }
}
