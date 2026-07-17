/**
 * Runtime validation primitives backed by Zod.
 * External data enters as unknown and becomes domain types only after validation.
 */

import { z } from "zod";
import semver from "semver";
import { CronExpressionParser } from "cron-parser";
import { validationError } from "../domain/errors.ts";
import { FPM_PROFILES } from "../domain/types.ts";

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

/** Map a Zod safeParse result into the project ParseResult shape. */
export function fromZod<T>(
  result: z.SafeParseReturnType<unknown, T>,
  field?: string,
): ParseResult<T> {
  if (result.success) return ok(result.data);
  return err(
    result.error.issues.map((issue) => {
      const path = [field, ...issue.path.map(String)].filter(Boolean).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  );
}

export function parseWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field?: string,
): ParseResult<T> {
  return fromZod(schema.safeParse(value), field);
}

// --- Shared field schemas -------------------------------------------------

export const nonEmptyStringSchema = z.string().min(1, "must not be empty");

/** App slug: lowercase alphanumeric + hyphens, 2-32 chars, starts with letter. */
export const appSlugSchema = z
  .string()
  .min(1, "must not be empty")
  .regex(
    /^[a-z][a-z0-9-]{1,31}$/,
    "must be 2-32 chars, start with a letter, and contain only lowercase letters, digits, and hyphens",
  );

/** Domain name validation (basic DNS label rules). */
export const domainNameSchema = z
  .string()
  .min(1, "must not be empty")
  .transform((s) => s.toLowerCase())
  .superRefine((domain, ctx) => {
    if (domain.length > 253) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "is too long" });
      return;
    }
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^localhost$|^[a-z0-9-]+$/
        .test(domain)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "is not a valid domain name",
      });
    }
  });

/** PHP version like 8.3, 8.4, 8.5 — major.minor only, validated via semver coerce. */
export const phpVersionSchema = z
  .string()
  .min(1, "must not be empty")
  .refine(
    (v) => /^\d+\.\d+$/.test(v) && semver.coerce(v) !== null,
    "must look like major.minor (e.g. 8.5)",
  );

/** MySQL version like 8.0, 8.4, 5.7 */
export const mysqlVersionSchema = z
  .string()
  .min(1, "must not be empty")
  .refine(
    (v) => /^\d+\.\d+$/.test(v) && semver.coerce(v) !== null,
    "must look like major.minor (e.g. 8.4)",
  );

/** Safe relative path under app home (no traversal). */
export const safeRelativePathSchema = z.string().superRefine((value, ctx) => {
  const p = value.replace(/\\/g, "/");
  if (p.startsWith("/") || p.includes("..") || p.includes("\0")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a relative path without '..' or absolute roots",
    });
  }
});

/** Cron expression (5-field) validated by cron-parser; shell metacharacters rejected. */
export const cronScheduleSchema = z
  .string()
  .min(1, "must not be empty")
  .transform((s) => s.trim())
  .superRefine((value, ctx) => {
    if (/[;|&`$(){}<>]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "contains unsafe characters",
      });
      return;
    }
    const parts = value.split(/\s+/);
    if (parts.length !== 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a 5-field cron expression",
      });
      return;
    }
    try {
      CronExpressionParser.parse(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "is not a valid cron expression",
      });
    }
  });

export const isoDateSchema = z
  .string()
  .min(1, "must not be empty")
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 timestamp");

export const stringArraySchema = z.array(nonEmptyStringSchema);

export const positiveIntSchema = z
  .number()
  .int("must be an integer")
  .positive("must be positive");

export const uidGidSchema = z
  .number()
  .int("must be an integer")
  .min(1000, "must be between 1000 and 65533")
  .max(65533, "must be between 1000 and 65533");

export const fpmProfileSchema = nonEmptyStringSchema.refine(
  (v) => v in FPM_PROFILES,
  {
    message: `must be one of: ${Object.keys(FPM_PROFILES).join(", ")}`,
  },
);

export const absolutePathSchema = nonEmptyStringSchema.refine(
  (v) => v.startsWith("/"),
  "must be absolute",
);

// --- Parse helpers (ParseResult API) ---------------------------------------

export function parseAppSlug(
  value: unknown,
  field = "slug",
): ParseResult<string> {
  return parseWith(appSlugSchema, value, field);
}

export function parseDomainName(
  value: unknown,
  field = "domain",
): ParseResult<string> {
  return parseWith(domainNameSchema, value, field);
}

export function parsePhpVersion(
  value: unknown,
  field = "phpVersion",
): ParseResult<string> {
  return parseWith(phpVersionSchema, value, field);
}

export function parseMysqlVersion(
  value: unknown,
  field = "mysqlVersion",
): ParseResult<string> {
  return parseWith(mysqlVersionSchema, value, field);
}

export function parseSafeRelativePath(
  value: unknown,
  field = "path",
): ParseResult<string> {
  return parseWith(safeRelativePathSchema, value, field);
}

export function parseCronSchedule(
  value: unknown,
  field = "schedule",
): ParseResult<string> {
  return parseWith(cronScheduleSchema, value, field);
}

export function parseIsoDate(
  value: unknown,
  field = "timestamp",
): ParseResult<string> {
  return parseWith(isoDateSchema, value, field);
}

export function parseStringArray(
  value: unknown,
  field: string,
): ParseResult<string[]> {
  return parseWith(stringArraySchema, value, field);
}

export function parsePositiveInt(
  value: unknown,
  field: string,
): ParseResult<number> {
  return parseWith(positiveIntSchema, value, field);
}

export function parseUidGid(
  value: unknown,
  field: string,
): ParseResult<number> {
  return parseWith(uidGidSchema, value, field);
}

/**
 * Compare major.minor product versions (PHP/MySQL) using semver.
 * Values like "8.4" are coerced to 8.4.0 for ordering.
 */
export function compareMajorMinor(a: string, b: string): number {
  const ca = semver.coerce(a);
  const cb = semver.coerce(b);
  if (ca && cb) return semver.compare(ca, cb);
  return a.localeCompare(b);
}
