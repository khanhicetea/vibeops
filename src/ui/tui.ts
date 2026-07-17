/**
 * Lightweight interactive terminal primitives for the Bento wizard.
 * Numbered menus, tables, alerts, messages, and text prompts.
 * No external TUI dependency — works under Deno source and compiled binaries.
 */

import pc from "picocolors";
import { printTable } from "./output.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type MenuChoice<T = string> = {
  /** Display label */
  label: string;
  /** Value returned on selection */
  value: T;
  /** Optional dim hint shown after the label */
  hint?: string;
  /** When true, choice is listed but not selectable */
  disabled?: boolean;
};

export type AlertLevel = "info" | "success" | "warn" | "error";

/** Normalized key events from raw or line-mode input. */
export type KeyEvent =
  | { type: "char"; char: string }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "backspace" }
  | { type: "eof" };

export type TerminalIO = {
  write(text: string): void;
  writeLine(text?: string): void;
  readLine(prompt?: string): Promise<string | null>;
  /** Single keypress (raw mode when available). */
  readKey(): Promise<KeyEvent>;
  isInteractive(): boolean;
  /** True when readKey can deliver arrows / instant digits without Enter. */
  supportsRawKeys(): boolean;
};

/** Default stdin/stdout terminal adapter. */
export function createStdTerminal(): TerminalIO {
  return {
    write(text: string) {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    writeLine(text = "") {
      Deno.stdout.writeSync(encoder.encode(text + "\n"));
    },
    async readLine(prompt?: string) {
      // Cooked TTY already echoes; do not re-echo. Read until newline.
      if (prompt) Deno.stdout.writeSync(encoder.encode(prompt));
      const chunks: Uint8Array[] = [];
      const chunk = new Uint8Array(256);
      while (true) {
        const n = await Deno.stdin.read(chunk);
        if (n === null) {
          if (chunks.length === 0) return null;
          break;
        }
        chunks.push(chunk.slice(0, n));
        if (chunk.subarray(0, n).includes(0x0a)) break;
      }
      return decoder.decode(concatChunks(chunks)).replace(/\r?\n$/, "").trim();
    },
    async readKey() {
      if (!this.supportsRawKeys()) {
        // Non-TTY fallback: whole line as chars + enter.
        const line = await this.readLine();
        if (line === null) return { type: "eof" };
        if (line === "") return { type: "enter" };
        return { type: "char", char: line.trim() };
      }

      Deno.stdin.setRaw(true);
      try {
        return await readRawKey();
      } finally {
        try {
          Deno.stdin.setRaw(false);
        } catch {
          // ignore restore failures
        }
      }
    },
    isInteractive() {
      try {
        return Deno.stdin.isTerminal() && Deno.stdout.isTerminal();
      } catch {
        return false;
      }
    },
    supportsRawKeys() {
      try {
        return Deno.stdin.isTerminal();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Read one logical key from stdin already in raw mode.
 * Arrow keys arrive as ESC [ A / ESC [ B (often one read of 3 bytes).
 */
async function readRawKey(): Promise<KeyEvent> {
  const buf = new Uint8Array(32);
  const n = await Deno.stdin.read(buf);
  if (n === null) return { type: "eof" };
  if (n === 0) return await readRawKey();

  const b0 = buf[0]!;

  // Ctrl+C / Ctrl+D
  if (b0 === 0x03 || b0 === 0x04) return { type: "eof" };
  // Enter
  if (b0 === 0x0d || b0 === 0x0a) return { type: "enter" };
  // Backspace
  if (b0 === 0x7f || b0 === 0x08) return { type: "backspace" };

  // ESC sequences (arrows) or bare Escape
  if (b0 === 0x1b) {
    if (n >= 3 && (buf[1] === 0x5b /* [ */ || buf[1] === 0x4f /* O */)) {
      const final = buf[n - 1]!;
      if (final === 0x41 /* A */) return { type: "up" };
      if (final === 0x42 /* B */) return { type: "down" };
      return { type: "char", char: "" };
    }
    // Bare Esc (or incomplete sequence delivered alone)
    return { type: "escape" };
  }

  // Printable ASCII (preserve case — menus lower-case themselves)
  if (b0 >= 0x20 && b0 <= 0x7e) {
    return { type: "char", char: String.fromCharCode(b0) };
  }
  return { type: "char", char: "" };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

export class WizardUI {
  constructor(private readonly io: TerminalIO = createStdTerminal()) {}

  isInteractive(): boolean {
    return this.io.isInteractive();
  }

  clear(): void {
    // Clear screen + home cursor (ANSI). Harmless on dumb terminals.
    this.io.write("\x1b[2J\x1b[H");
  }

  blank(): void {
    this.io.writeLine();
  }

  /** Section / screen header. */
  header(title: string, subtitle?: string): void {
    this.io.writeLine();
    this.io.writeLine(pc.bold(pc.cyan(`╔════════════════════════════════════════════════════════════╗`)));
    const pad = (s: string, w: number) => {
      const bare = s.length > w ? s.slice(0, w) : s;
      return bare + " ".repeat(Math.max(0, w - bare.length));
    };
    this.io.writeLine(pc.bold(pc.cyan(`║ `)) + pc.bold(pad(title, 58)) + pc.bold(pc.cyan(` ║`)));
    if (subtitle) {
      this.io.writeLine(pc.cyan(`║ `) + pc.dim(pad(subtitle, 58)) + pc.cyan(` ║`));
    }
    this.io.writeLine(pc.bold(pc.cyan(`╚════════════════════════════════════════════════════════════╝`)));
    this.io.writeLine();
  }

  /** Plain operator message. */
  message(msg: string): void {
    this.io.writeLine(msg);
  }

  info(msg: string): void {
    this.io.writeLine(pc.dim(msg));
  }

  /** Boxed alert for success / warn / error / info. */
  alert(level: AlertLevel, title: string, detail?: string): void {
    const paint = {
      info: pc.cyan,
      success: pc.green,
      warn: pc.yellow,
      error: pc.red,
    }[level];
    const tag = {
      info: "INFO",
      success: "OK",
      warn: "WARN",
      error: "ERROR",
    }[level];
    this.io.writeLine(paint(`┌─ ${tag}: ${title}`));
    if (detail) {
      for (const line of detail.split("\n")) {
        this.io.writeLine(paint(`│  ${line}`));
      }
    }
    this.io.writeLine(paint(`└${"─".repeat(Math.min(48, title.length + 10))}`));
  }

  success(title: string, detail?: string): void {
    this.alert("success", title, detail);
  }

  warn(title: string, detail?: string): void {
    this.alert("warn", title, detail);
  }

  error(title: string, detail?: string): void {
    this.alert("error", title, detail);
  }

  /** Render an aligned table (reuses cliui printTable). */
  table(headers: string[], rows: string[][]): void {
    if (rows.length === 0) {
      this.info("(empty)");
      return;
    }
    this.io.writeLine(printTable(headers, rows));
  }

  /**
   * Interactive numbered menu.
   *
   * - ↑/↓ (or j/k) move highlight; Enter selects
   * - Single key selects immediately when item count &lt; 10 (digits 1–9)
   * - With 10+ items, keys 1–9 / a–z still select immediately (each key is unique)
   * - `0` / `q` / Esc cancels when allowCancel
   */
  async menu<T>(
    title: string,
    choices: MenuChoice<T>[],
    opts?: { allowCancel?: boolean; cancelLabel?: string; subtitle?: string },
  ): Promise<T | null> {
    const allowCancel = opts?.allowCancel !== false;
    const cancelLabel = opts?.cancelLabel ?? "Back / cancel";
    const raw = this.io.supportsRawKeys();
    // Instant single-key select whenever every choice maps to a one-char key
    // (always true for our 1–9/a–z scheme under 35 items).
    const instantKeys = choices.length < 10 || raw;

    this.io.writeLine(pc.bold(title));
    if (opts?.subtitle) this.io.writeLine(pc.dim(opts.subtitle));
    this.io.writeLine();

    const keys = choices.map((_, i) => menuKey(i));
    let cursor = firstEnabledIndex(choices);
    if (cursor < 0 && allowCancel) cursor = -1; // cancel row
    if (cursor < 0 && !allowCancel) cursor = 0;

    let status = "";

    const help = raw
      ? "↑/↓ move · key selects · Enter confirms · 0/Esc back"
      : "Type key and press Enter · 0 back";

    const draw = (): number => {
      let lines = 0;
      for (let i = 0; i < choices.length; i++) {
        this.io.writeLine(formatChoiceLine(choices[i]!, keys[i]!, i === cursor));
        lines++;
      }
      if (allowCancel) {
        this.io.writeLine(formatCancelLine(cancelLabel, cursor === -1));
        lines++;
      }
      this.io.writeLine();
      lines++;
      this.io.writeLine(pc.dim(help));
      lines++;
      if (status) {
        this.io.writeLine(pc.yellow(status));
        lines++;
      } else {
        this.io.writeLine(""); // reserve status line for stable redraw height
        lines++;
      }
      return lines;
    };

    const erase = (lineCount: number) => {
      if (lineCount <= 0) return;
      // Move to start of menu block and clear downward.
      this.io.write(`\x1b[${lineCount}A\x1b[J`);
    };

    // Hide cursor while navigating when raw.
    if (raw) this.io.write("\x1b[?25l");
    let lineCount = draw();

    try {
      while (true) {
        const key = await this.io.readKey();

        if (key.type === "eof") return null;

        if (key.type === "escape") {
          if (allowCancel) return null;
          status = "Selection required";
          erase(lineCount);
          lineCount = draw();
          continue;
        }

        if (key.type === "up") {
          cursor = moveCursor(choices, cursor, -1, allowCancel);
          status = "";
          erase(lineCount);
          lineCount = draw();
          continue;
        }

        if (key.type === "down") {
          cursor = moveCursor(choices, cursor, 1, allowCancel);
          status = "";
          erase(lineCount);
          lineCount = draw();
          continue;
        }

        if (key.type === "enter") {
          if (cursor === -1) {
            if (allowCancel) return null;
            status = "Selection required";
            erase(lineCount);
            lineCount = draw();
            continue;
          }
          const choice = choices[cursor]!;
          if (choice.disabled) {
            status = "That option is not available";
            erase(lineCount);
            lineCount = draw();
            continue;
          }
          return choice.value;
        }

        if (key.type === "backspace") {
          continue;
        }

        if (key.type === "char") {
          const ch = key.char.toLowerCase();
          if (!ch) continue;

          // j/k vim-style navigation when those keys are not menu bindings
          if (raw && (ch === "j" || ch === "k") && !keys.includes(ch)) {
            cursor = moveCursor(choices, cursor, ch === "j" ? 1 : -1, allowCancel);
            status = "";
            erase(lineCount);
            lineCount = draw();
            continue;
          }

          // Cancel shortcuts
          if (ch === "0" || ch === "q") {
            if (allowCancel) return null;
            status = "Selection required";
            erase(lineCount);
            lineCount = draw();
            continue;
          }

          // Instant key select (no Enter) when raw, or always for <10 items.
          if (instantKeys || ch.length === 1) {
            const result = resolveKey(ch, keys, choices, allowCancel);
            if (result === "cancel") return null;
            if (result === "disabled") {
              status = "That option is not available";
              erase(lineCount);
              lineCount = draw();
              continue;
            }
            if (result === "invalid") {
              status = `Invalid choice "${ch}"`;
              erase(lineCount);
              lineCount = draw();
              continue;
            }
            cursor = keys.indexOf(ch);
            erase(lineCount);
            lineCount = draw();
            return result.value;
          }
        }
      }
    } finally {
      if (raw) this.io.write("\x1b[?25h");
      // Leave final menu state on screen; add a blank line after selection.
      this.io.writeLine();
    }
  }

  /** Free-text prompt. Returns null on EOF/cancel. Empty allowed unless required. */
  async prompt(
    label: string,
    opts?: { default?: string; required?: boolean; secret?: boolean },
  ): Promise<string | null> {
    const def = opts?.default;
    const suffix = def !== undefined && def !== "" ? pc.dim(` [${def}]`) : "";
    while (true) {
      const raw = await this.io.readLine(`${pc.bold(label)}${suffix}: `);
      if (raw === null) return null;
      const value = raw === "" && def !== undefined ? def : raw;
      if (opts?.required && value.trim() === "") {
        this.warn("A value is required");
        continue;
      }
      return value;
    }
  }

  /** Yes/no confirm. Default false unless defaultYes. Instant y/n in raw mode. */
  async confirm(question: string, opts?: { defaultYes?: boolean }): Promise<boolean> {
    const def = opts?.defaultYes ? "Y/n" : "y/N";
    const prompt = `${pc.bold(question)} ${pc.dim(`(${def})`)}: `;

    if (this.io.supportsRawKeys()) {
      this.io.write(prompt);
      while (true) {
        const key = await this.io.readKey();
        if (key.type === "eof" || key.type === "escape") {
          this.io.writeLine("n");
          return false;
        }
        if (key.type === "enter") {
          this.io.writeLine(opts?.defaultYes ? "y" : "n");
          return !!opts?.defaultYes;
        }
        if (key.type === "char") {
          const a = key.char.toLowerCase();
          if (a === "y") {
            this.io.writeLine("y");
            return true;
          }
          if (a === "n") {
            this.io.writeLine("n");
            return false;
          }
        }
      }
    }

    while (true) {
      const raw = await this.io.readLine(prompt);
      if (raw === null) return false;
      const a = raw.trim().toLowerCase();
      if (a === "") return !!opts?.defaultYes;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      this.warn("Please answer y or n");
    }
  }

  /** Pause until Enter. */
  async pause(label = "Press Enter to continue…"): Promise<void> {
    if (this.io.supportsRawKeys()) {
      this.io.write(pc.dim(label + " "));
      while (true) {
        const key = await this.io.readKey();
        if (key.type === "enter" || key.type === "eof" || key.type === "escape") {
          this.io.writeLine();
          return;
        }
      }
    }
    await this.io.readLine(pc.dim(label + " "));
  }

  /** Multi-line note block. */
  note(lines: string[]): void {
    for (const line of lines) this.io.writeLine(pc.dim(`  ${line}`));
  }
}

/** Map index 0→"1", 8→"9", 9→"a", 10→"b", … */
function menuKey(index: number): string {
  if (index < 9) return String(index + 1);
  const letter = index - 9;
  if (letter < 26) return String.fromCharCode(97 + letter);
  return String(index + 1);
}

function firstEnabledIndex<T>(choices: MenuChoice<T>[]): number {
  for (let i = 0; i < choices.length; i++) {
    if (!choices[i]!.disabled) return i;
  }
  return -1;
}

function moveCursor<T>(
  choices: MenuChoice<T>[],
  cursor: number,
  delta: number,
  allowCancel: boolean,
): number {
  // Positions: 0..n-1 for choices, -1 for cancel (if allowed).
  const positions: number[] = [];
  for (let i = 0; i < choices.length; i++) {
    if (!choices[i]!.disabled) positions.push(i);
  }
  if (allowCancel) positions.push(-1);
  if (positions.length === 0) return cursor;

  let idx = positions.indexOf(cursor);
  if (idx < 0) idx = 0;
  idx = (idx + delta + positions.length * 10) % positions.length;
  return positions[idx]!;
}

function formatChoiceLine<T>(choice: MenuChoice<T>, key: string, selected: boolean): string {
  const marker = selected ? pc.bold(pc.cyan("❯")) : " ";
  const prefix = choice.disabled
    ? pc.dim(` ${marker} [${key}]`)
    : selected
    ? pc.bold(pc.cyan(` ${marker} [${key}]`))
    : pc.bold(pc.green(` ${marker} [${key}]`));
  const label = choice.disabled
    ? pc.dim(choice.label)
    : selected
    ? pc.bold(pc.cyan(choice.label))
    : choice.label;
  const hint = choice.hint ? pc.dim(`  — ${choice.hint}`) : "";
  return `${prefix}  ${label}${hint}`;
}

function formatCancelLine(label: string, selected: boolean): string {
  const marker = selected ? pc.bold(pc.cyan("❯")) : " ";
  if (selected) {
    return pc.bold(pc.cyan(` ${marker} [0]  ${label}`));
  }
  return pc.dim(` ${marker} [0]  ${label}`);
}

type ResolveResult<T> =
  | { value: T }
  | "cancel"
  | "disabled"
  | "invalid";

function resolveKey<T>(
  answer: string,
  keys: string[],
  choices: MenuChoice<T>[],
  allowCancel: boolean,
): ResolveResult<T> {
  const a = answer.trim().toLowerCase();
  if (a === "0" || a === "q" || a === "b") {
    return allowCancel ? "cancel" : "invalid";
  }
  const idx = keys.indexOf(a);
  if (idx < 0) return "invalid";
  const choice = choices[idx]!;
  if (choice.disabled) return "disabled";
  return { value: choice.value };
}
