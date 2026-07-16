/**
 * Lightweight runtime validation primitives.
 * External data enters as unknown and becomes domain types only after validation.
 */

import { validationError } from "../domain/errors.ts";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function err(errors: string | string[]): ParseResult<never> {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors] };
}

export function unwrap<T>(result: ParseResult<T>, context = "value"): T {
  if (!result.ok) {
    throw validationError(`${context}: ${result.errors.join("; ")}`, {
      errors: result.errors,
    });
  }
  return result.value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, field: string): ParseResult<string> {
  if (typeof value !== "string") return err(`${field} must be a string`);
  return ok(value);
}

export function asNonEmptyString(
  value: unknown,
  field: string,
): ParseResult<string> {
  const s = asString(value, field);
  if (!s.ok) return s;
  if (s.value.trim() === "") return err(`${field} must not be empty`);
  return ok(s.value);
}

export function asNumber(value: unknown, field: string): ParseResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return err(`${field} must be a finite number`);
  }
  return ok(value);
}

export function asInteger(value: unknown, field: string): ParseResult<number> {
  const n = asNumber(value, field);
  if (!n.ok) return n;
  if (!Number.isInteger(n.value)) return err(`${field} must be an integer`);
  return ok(n.value);
}

export function asBoolean(value: unknown, field: string): ParseResult<boolean> {
  if (typeof value !== "boolean") return err(`${field} must be a boolean`);
  return ok(value);
}

export function asArray(value: unknown, field: string): ParseResult<unknown[]> {
  if (!Array.isArray(value)) return err(`${field} must be an array`);
  return ok(value);
}

export function asOptional<T>(
  value: unknown,
  parse: (v: unknown) => ParseResult<T>,
): ParseResult<T | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  return parse(value);
}

export function oneOf<T extends string>(
  value: unknown,
  field: string,
  options: readonly T[],
): ParseResult<T> {
  const s = asString(value, field);
  if (!s.ok) return s;
  if (!(options as readonly string[]).includes(s.value)) {
    return err(`${field} must be one of: ${options.join(", ")}`);
  }
  return ok(s.value as T);
}

/** App slug: lowercase alphanumeric + hyphens, 2-32 chars, starts with letter. */
export function parseAppSlug(value: unknown, field = "slug"): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(s.value)) {
    return err(
      `${field} must be 2-32 chars, start with a letter, and contain only lowercase letters, digits, and hyphens`,
    );
  }
  return ok(s.value);
}

/** Domain name validation (basic DNS label rules). */
export function parseDomainName(
  value: unknown,
  field = "domain",
): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  const domain = s.value.toLowerCase();
  if (domain.length > 253) return err(`${field} is too long`);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^localhost$|^[a-z0-9-]+$/.test(
      domain,
    )
  ) {
    return err(`${field} is not a valid domain name`);
  }
  return ok(domain);
}

/** PHP version like 8.3, 8.4, 8.5 */
export function parsePhpVersion(
  value: unknown,
  field = "phpVersion",
): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  if (!/^\d+\.\d+$/.test(s.value)) {
    return err(`${field} must look like major.minor (e.g. 8.5)`);
  }
  return ok(s.value);
}

/** MySQL version like 8.0, 8.4, 5.7 */
export function parseMysqlVersion(
  value: unknown,
  field = "mysqlVersion",
): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  if (!/^\d+\.\d+$/.test(s.value)) {
    return err(`${field} must look like major.minor (e.g. 8.4)`);
  }
  return ok(s.value);
}

/** Safe relative path under app home (no traversal). */
export function parseSafeRelativePath(
  value: unknown,
  field = "path",
): ParseResult<string> {
  const s = asString(value, field);
  if (!s.ok) return s;
  const p = s.value.replace(/\\/g, "/");
  if (p.startsWith("/") || p.includes("..") || p.includes("\0")) {
    return err(`${field} must be a relative path without '..' or absolute roots`);
  }
  return ok(p);
}

/** Cron expression (5-field). */
export function parseCronSchedule(
  value: unknown,
  field = "schedule",
): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  const parts = s.value.trim().split(/\s+/);
  if (parts.length !== 5) {
    return err(`${field} must be a 5-field cron expression`);
  }
  // Reject shell metacharacters
  if (/[;|&`$(){}<>]/.test(s.value)) {
    return err(`${field} contains unsafe characters`);
  }
  return ok(s.value.trim());
}

export function parseIsoDate(
  value: unknown,
  field = "timestamp",
): ParseResult<string> {
  const s = asNonEmptyString(value, field);
  if (!s.ok) return s;
  const d = Date.parse(s.value);
  if (Number.isNaN(d)) return err(`${field} must be an ISO-8601 timestamp`);
  return ok(s.value);
}

export function parseStringArray(
  value: unknown,
  field: string,
): ParseResult<string[]> {
  const arr = asArray(value, field);
  if (!arr.ok) return arr;
  const out: string[] = [];
  for (let i = 0; i < arr.value.length; i++) {
    const item = asNonEmptyString(arr.value[i], `${field}[${i}]`);
    if (!item.ok) return item;
    out.push(item.value);
  }
  return ok(out);
}

export function parsePositiveInt(
  value: unknown,
  field: string,
): ParseResult<number> {
  const n = asInteger(value, field);
  if (!n.ok) return n;
  if (n.value <= 0) return err(`${field} must be positive`);
  return ok(n.value);
}

export function parseUidGid(value: unknown, field: string): ParseResult<number> {
  const n = asInteger(value, field);
  if (!n.ok) return n;
  if (n.value < 1000 || n.value > 65533) {
    return err(`${field} must be between 1000 and 65533`);
  }
  return ok(n.value);
}
