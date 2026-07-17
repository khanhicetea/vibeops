import { assertEquals } from "@std/assert";
import { type KeyEvent, type MenuChoice, type TerminalIO, WizardUI } from "../../src/ui/tui.ts";

/**
 * Fake terminal. String tokens map to key events:
 *   "up" | "down" | "enter" | "esc" | "backspace" | single chars
 * Or pass KeyEvent objects directly.
 */
function fakeTerminal(
  inputs: Array<string | KeyEvent>,
  opts?: { raw?: boolean },
): TerminalIO & { out: string[] } {
  const queue = [...inputs];
  const out: string[] = [];
  const raw = opts?.raw !== false;

  function nextKey(): KeyEvent {
    if (queue.length === 0) return { type: "eof" };
    const item = queue.shift()!;
    if (typeof item !== "string") return item;
    if (item === "up") return { type: "up" };
    if (item === "down") return { type: "down" };
    if (item === "enter") return { type: "enter" };
    if (item === "esc" || item === "escape") return { type: "escape" };
    if (item === "backspace") return { type: "backspace" };
    if (item === "") return { type: "enter" };
    return { type: "char", char: item[0]!.toLowerCase() };
  }

  return {
    out,
    write(text: string) {
      out.push(text);
    },
    writeLine(text = "") {
      out.push(text + "\n");
    },
    async readLine(_prompt?: string) {
      // Line mode: consume until enter-like token
      const parts: string[] = [];
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (typeof item !== "string") {
          if (item.type === "enter") break;
          if (item.type === "eof") return parts.length ? parts.join("") : null;
          continue;
        }
        if (item === "enter" || item === "") break;
        if (item === "esc") return null;
        parts.push(item);
      }
      if (parts.length === 0 && queue.length === 0 && !raw) return null;
      return parts.join("");
    },
    async readKey() {
      return nextKey();
    },
    isInteractive() {
      return true;
    },
    supportsRawKeys() {
      return raw;
    },
  };
}

Deno.test("menu selects numbered choice instantly when <10 items", async () => {
  const io = fakeTerminal(["2"]);
  const ui = new WizardUI(io);
  const choices: MenuChoice<string>[] = [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
    { label: "Gamma", value: "c" },
  ];
  const picked = await ui.menu("Pick", choices);
  assertEquals(picked, "b");
});

Deno.test("menu cancel with 0", async () => {
  const io = fakeTerminal(["0"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [{ label: "Only", value: "x" }]);
  assertEquals(picked, null);
});

Deno.test("menu cancel with Escape", async () => {
  const io = fakeTerminal(["esc"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [{ label: "Only", value: "x" }]);
  assertEquals(picked, null);
});

Deno.test("menu rejects disabled then accepts", async () => {
  const io = fakeTerminal(["1", "2"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [
    { label: "Disabled", value: "no", disabled: true },
    { label: "Enabled", value: "yes" },
  ]);
  assertEquals(picked, "yes");
});

Deno.test("menu arrow down + enter selects", async () => {
  const io = fakeTerminal(["down", "down", "enter"]);
  const ui = new WizardUI(io);
  const choices: MenuChoice<string>[] = [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
    { label: "Gamma", value: "c" },
  ];
  const picked = await ui.menu("Pick", choices);
  assertEquals(picked, "c");
});

Deno.test("menu arrow up wraps to cancel then enter", async () => {
  const io = fakeTerminal(["up", "enter"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
  ]);
  assertEquals(picked, null);
});

Deno.test("menu skips disabled with arrows", async () => {
  const io = fakeTerminal(["down", "enter"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [
    { label: "First", value: "first" },
    { label: "Disabled", value: "no", disabled: true },
    { label: "Third", value: "third" },
  ]);
  assertEquals(picked, "third");
});

Deno.test("menu with >=10 items still selects letter key instantly", async () => {
  const choices: MenuChoice<string>[] = Array.from({ length: 12 }, (_, i) => ({
    label: `Item ${i + 1}`,
    value: `v${i + 1}`,
  }));
  // key "a" is item 10 (index 9) — single key, no Enter needed
  const io = fakeTerminal(["a"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", choices);
  assertEquals(picked, "v10");
});

Deno.test("menu letter b selects item 11 rather than cancelling", async () => {
  const choices: MenuChoice<string>[] = Array.from({ length: 12 }, (_, i) => ({
    label: `Item ${i + 1}`,
    value: `v${i + 1}`,
  }));
  const io = fakeTerminal(["b"]);
  const ui = new WizardUI(io);
  assertEquals(await ui.menu("Pick", choices), "v11");
});

Deno.test("table menu aligns columns and selects a row", async () => {
  const io = fakeTerminal(["2"]);
  const ui = new WizardUI(io);
  const picked = await ui.tableMenu("Choose backup", ["File", "Created", "Size"], [
    { columns: ["older.sql.zst", "2026-07-16", "1.5 MiB"], value: "older" },
    { columns: ["newer.sql.zst", "2026-07-17", "2 MiB"], value: "newer" },
    { columns: ["Path of file…", "", ""], value: "path" },
  ]);
  assertEquals(picked, "newer");
  const output = io.out.join("");
  assertEquals(output.includes("Created"), true);
  assertEquals(output.includes("1.5 MiB"), true);
  assertEquals(output.includes("Path of file…"), true);
});

Deno.test("menu j/k navigation when <10", async () => {
  const io = fakeTerminal(["j", "enter"]);
  const ui = new WizardUI(io);
  const picked = await ui.menu("Pick", [
    { label: "Alpha", value: "a" },
    { label: "Beta", value: "b" },
  ]);
  assertEquals(picked, "b");
});

Deno.test("confirm yes/no/default with raw keys", async () => {
  const io = fakeTerminal(["y", "n", "enter"]);
  const ui = new WizardUI(io);
  assertEquals(await ui.confirm("Go?"), true);
  assertEquals(await ui.confirm("Go?"), false);
  assertEquals(await ui.confirm("Go?", { defaultYes: true }), true);
});

Deno.test("confirm line mode without raw", async () => {
  const io = fakeTerminal(["y", "enter", "n", "enter", "enter"], { raw: false });
  // Without raw, confirm uses readLine — feed full answers as line tokens
  const io2 = fakeTerminal([]);
  // custom line-mode terminal
  const lines = ["y", "n", ""];
  const lineIo: TerminalIO & { out: string[] } = {
    out: [],
    write(t) {
      lineIo.out.push(t);
    },
    writeLine(t = "") {
      lineIo.out.push(t + "\n");
    },
    async readLine() {
      if (lines.length === 0) return null;
      return lines.shift()!;
    },
    async readKey() {
      return { type: "eof" };
    },
    isInteractive: () => true,
    supportsRawKeys: () => false,
  };
  const ui = new WizardUI(lineIo);
  assertEquals(await ui.confirm("Go?"), true);
  assertEquals(await ui.confirm("Go?"), false);
  assertEquals(await ui.confirm("Go?", { defaultYes: true }), true);
  // silence unused
  assertEquals(io.supportsRawKeys(), false);
  assertEquals(io2.out.length, 0);
});

Deno.test("prompt uses default on empty", async () => {
  const lines = [""];
  const io: TerminalIO & { out: string[] } = {
    out: [],
    write(t) {
      io.out.push(t);
    },
    writeLine(t = "") {
      io.out.push(t + "\n");
    },
    async readLine() {
      return lines.shift() ?? null;
    },
    async readKey() {
      return { type: "eof" };
    },
    isInteractive: () => true,
    supportsRawKeys: () => false,
  };
  const ui = new WizardUI(io);
  assertEquals(await ui.prompt("Name", { default: "demo" }), "demo");
});

Deno.test("prompt required retries", async () => {
  const lines = ["", "ok"];
  const io: TerminalIO & { out: string[] } = {
    out: [],
    write(t) {
      io.out.push(t);
    },
    writeLine(t = "") {
      io.out.push(t + "\n");
    },
    async readLine() {
      return lines.shift() ?? null;
    },
    async readKey() {
      return { type: "eof" };
    },
    isInteractive: () => true,
    supportsRawKeys: () => false,
  };
  const ui = new WizardUI(io);
  assertEquals(await ui.prompt("Name", { required: true }), "ok");
});

Deno.test("alert and table emit output", () => {
  const io = fakeTerminal([]);
  const ui = new WizardUI(io);
  ui.alert("success", "done", "detail line");
  ui.table(["a", "b"], [["1", "2"]]);
  const joined = io.out.join("");
  assertEquals(joined.includes("done"), true);
  assertEquals(joined.includes("detail line"), true);
  assertEquals(joined.includes("1"), true);
});
