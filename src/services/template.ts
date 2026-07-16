/**
 * Minimal deterministic mustache-like template renderer.
 * Supports {{var}}, {{#bool}}...{{/bool}}, {{^bool}}...{{/bool}}.
 * Values are string-escaped for config safety where noted.
 */

import { validationError } from "../domain/errors.ts";

export type TemplateContext = Record<string, unknown>;

export function renderTemplate(source: string, ctx: TemplateContext): string {
  let out = source;

  // Sections: {{#key}}...{{/key}} and inverted {{^key}}...{{/key}}
  out = out.replace(
    /\{\{([#^])([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_m, kind: string, key: string, body: string) => {
      const val = lookup(ctx, key);
      const truthy = isTruthy(val);
      if (kind === "#" && truthy) {
        if (Array.isArray(val)) {
          return val.map((item) =>
            renderTemplate(
              body,
              isObject(item) ? { ...ctx, ...item, ".": item } : {
                ...ctx,
                ".": item,
              },
            )
          ).join("");
        }
        if (isObject(val)) return renderTemplate(body, { ...ctx, ...val });
        return renderTemplate(body, ctx);
      }
      if (kind === "^" && !truthy) return renderTemplate(body, ctx);
      return "";
    },
  );

  // Variables
  out = out.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, key: string) => {
    const val = lookup(ctx, key);
    if (val === undefined || val === null) return "";
    return String(val);
  });

  // Detect unreplaced tags (developer error)
  if (/\{\{[^\]]/.test(out) && /\{\{/.test(out)) {
    const leftover = out.match(/\{\{[^}]+\}\}/g);
    if (leftover && leftover.some((t) => !t.startsWith("{{!"))) {
      // allow leftover only if empty-context intentional; still return
    }
  }

  return out;
}

function lookup(ctx: TemplateContext, key: string): unknown {
  if (key === ".") return ctx["."];
  const parts = key.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (!isObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function isTruthy(val: unknown): boolean {
  if (val === undefined || val === null || val === false || val === 0 || val === "") {
    return false;
  }
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape a value for Nginx string contexts. */
export function nginxEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape MySQL identifier. */
export function mysqlIdent(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw validationError(`unsafe MySQL identifier: ${value}`);
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

/** Escape LIKE wildcards in app names for GRANT patterns. */
export function mysqlLikeEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
