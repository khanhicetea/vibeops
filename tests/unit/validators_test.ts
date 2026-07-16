import { assertEquals, assertThrows } from "@std/assert";
import {
  parseAppSlug,
  parseCronSchedule,
  parseDomainName,
  parsePhpVersion,
  parseSafeRelativePath,
  unwrap,
} from "../../src/schemas/validators.ts";
import { loadStateFromJson, parseDesiredState } from "../../src/schemas/state.ts";
import { createEmptyState, stateToJson } from "../../src/schemas/state.ts";
import { STATE_SCHEMA_VERSION } from "../../src/version.ts";

Deno.test("parseAppSlug accepts valid slugs", () => {
  assertEquals(parseAppSlug("my-app").ok, true);
  assertEquals(parseAppSlug("ab").ok, true);
});

Deno.test("parseAppSlug rejects invalid slugs", () => {
  assertEquals(parseAppSlug("A").ok, false);
  assertEquals(parseAppSlug("1abc").ok, false);
  assertEquals(parseAppSlug("has_underscore").ok, false);
});

Deno.test("parseDomainName normalizes case", () => {
  const r = parseDomainName("Example.COM");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value, "example.com");
});

Deno.test("parseSafeRelativePath rejects traversal", () => {
  assertEquals(parseSafeRelativePath("../etc").ok, false);
  assertEquals(parseSafeRelativePath("/abs").ok, false);
  assertEquals(parseSafeRelativePath("public").ok, true);
});

Deno.test("parseCronSchedule requires 5 fields and rejects shell metacharacters", () => {
  assertEquals(parseCronSchedule("*/5 * * * *").ok, true);
  assertEquals(parseCronSchedule("* * * *").ok, false);
  assertEquals(parseCronSchedule("* * * * *; rm -rf /").ok, false);
});

Deno.test("parsePhpVersion", () => {
  assertEquals(parsePhpVersion("8.5").ok, true);
  assertEquals(parsePhpVersion("8").ok, false);
});

Deno.test("empty state round-trips through schema", () => {
  const state = createEmptyState("2026-01-01T00:00:00.000Z");
  const json = stateToJson(state);
  const loaded = loadStateFromJson(json);
  assertEquals(loaded.schemaVersion, STATE_SCHEMA_VERSION);
  assertEquals(loaded.defaults.phpVersion, "8.5");
  assertEquals(loaded.phpVersions.length, 1);
  assertEquals(loaded.mysqlVersions.length, 1);
});

Deno.test("future schema version is rejected without mutation", () => {
  const raw = {
    ...createEmptyState("2026-01-01T00:00:00.000Z"),
    schemaVersion: 999,
  };
  const result = parseDesiredState(raw);
  assertEquals(result.ok, false);
});

Deno.test("corrupt JSON throws", () => {
  assertThrows(() => loadStateFromJson("{not json"), Error);
});

Deno.test("unwrap throws on error", () => {
  assertThrows(() => unwrap(parseAppSlug(""), "slug"), Error);
});
