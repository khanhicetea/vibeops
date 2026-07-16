/**
 * Minimal YAML emitter for Compose documents.
 * Sufficient for our generated service graphs (maps, arrays, scalars, null).
 */

export function stringify(value: unknown): string {
  return dump(value, 0) + "\n";
}

function dump(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return dumpString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(indent);
    return value.map((item) => {
      if (isPlainObject(item) || Array.isArray(item)) {
        const body = dump(item, indent + 1);
        if (body.includes("\n")) {
          const indented = body.replace(/\n/g, `\n${pad}  `);
          return `${pad}- ${indented.replace(/^ {2}/, "")}`;
        }
        return `${pad}- ${body}`;
      }
      return `${pad}- ${dump(item, indent + 1)}`;
    }).join("\n");
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const pad = "  ".repeat(indent);
    return keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      if (v !== null && (isPlainObject(v) || Array.isArray(v))) {
        const nested = dump(v, indent + 1);
        if (nested === "[]" || nested === "{}" || nested === "null") {
          return `${pad}${k}: ${nested}`;
        }
        return `${pad}${k}:\n${nested}`;
      }
      return `${pad}${k}: ${dump(v, indent + 1)}`;
    }).join("\n");
  }
  return dumpString(String(value));
}

function dumpString(s: string): string {
  if (s === "") return '""';
  if (/^[-:?\[\]{},&*#%!|>'"@`]/.test(s) || /[\n:#]/.test(s) || s !== s.trim()) {
    return JSON.stringify(s);
  }
  if (["true", "false", "null", "yes", "no", "on", "off"].includes(s.toLowerCase())) {
    return JSON.stringify(s);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return JSON.stringify(s);
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
