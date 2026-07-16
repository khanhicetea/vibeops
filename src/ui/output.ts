/** Operator-facing output helpers (no secrets). */

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

export function printTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(r.map((c) => c ?? "")));
  return out.join("\n");
}

/** Redact common secret-like values from diagnostics. */
export function redact(text: string): string {
  return text
    .replace(/(password["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1***")
    .replace(/(secret["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1***")
    .replace(/(MYSQL_PWD=)(\S+)/g, "$1***")
    .replace(/(hmacSecret["']?\s*:\s*["'])([^"']+)/g, "$1***");
}
