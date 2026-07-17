/**
 * Deterministic Mustache template renderer for nginx/php/config generation.
 * HTML escaping is disabled — templates emit config files, not HTML.
 */

import Mustache from "mustache";
import { validationError } from "../domain/errors.ts";

export type TemplateContext = Record<string, unknown>;

// Config generation must not HTML-escape paths, secrets, or server names.
Mustache.escape = (value: string) => value;

export function renderTemplate(source: string, ctx: TemplateContext): string {
  return Mustache.render(source, ctx);
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
