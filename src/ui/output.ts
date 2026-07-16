/** Operator-facing output helpers (no secrets). */

import cliui from "cliui";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  out: (msg: string) => void;
};

export function createLogger(opts?: { json?: boolean }): Logger {
  return {
    info(msg: string) {
      if (opts?.json) console.error(JSON.stringify({ level: "info", msg }));
      else console.error(msg);
    },
    warn(msg: string) {
      if (opts?.json) console.error(JSON.stringify({ level: "warn", msg }));
      else console.error(`warning: ${msg}`);
    },
    error(msg: string) {
      if (opts?.json) console.error(JSON.stringify({ level: "error", msg }));
      else console.error(`error: ${msg}`);
    },
    out(msg: string) {
      console.log(msg);
    },
  };
}

/** Format a simple aligned table via cliui. */
export function printTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 1)
  );
  const colGap = 2;
  const totalWidth = widths.reduce((sum, w) => sum + w + colGap, 0);
  const ui = cliui({ width: Math.max(totalWidth, 40), wrap: false });

  const cells = (cols: string[]) =>
    cols.map((c, i) => ({
      text: c,
      width: widths[i]! + colGap,
      padding: [0, 0, 0, 0] as [number, number, number, number],
    }));

  ui.div(...cells(headers));
  ui.div(...cells(widths.map((w) => "-".repeat(w))));
  for (const row of rows) {
    ui.div(...cells(headers.map((_, i) => row[i] ?? "")));
  }
  return ui.toString().replace(/\s+$/gm, "");
}

/** Multi-column help / section layout via cliui. */
export function printColumns(
  pairs: Array<[string, string]>,
  opts?: { leftWidth?: number; width?: number },
): string {
  const leftWidth = opts?.leftWidth ?? 28;
  const ui = cliui({ width: opts?.width ?? 100, wrap: true });
  for (const [left, right] of pairs) {
    ui.div(
      { text: left, width: leftWidth, padding: [0, 2, 0, 0] },
      { text: right },
    );
  }
  return ui.toString().replace(/\s+$/gm, "");
}

/** Redact common secret-like values from diagnostics. */
export function redact(text: string): string {
  return text
    .replace(/(password["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1***")
    .replace(/(secret["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1***")
    .replace(/(MYSQL_PWD=)(\S+)/g, "$1***")
    .replace(/(hmacSecret["']?\s*:\s*["'])([^"']+)/g, "$1***");
}
