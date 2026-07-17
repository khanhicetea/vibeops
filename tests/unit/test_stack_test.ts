/**
 * Pure helpers for the real-stack harness (no Docker required).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_SCHEDULE_WAIT_SEC,
  DEFAULT_TEST_STACK_NAME,
  formatTestStackReport,
  resolveTestStackOptions,
  type TestStackReport,
} from "../../src/services/test_stack.ts";
import { resolve } from "@std/path";

Deno.test("test-stack default name is testbento", () => {
  assertEquals(DEFAULT_TEST_STACK_NAME, "testbento");
  assertEquals(DEFAULT_SCHEDULE_WAIT_SEC, 61);
  const opts = resolveTestStackOptions({});
  assertEquals(opts.name, "testbento");
  assertEquals(opts.stackRoot, resolve("./testbento"));
  assertEquals(opts.keep, false);
  assertEquals(opts.skipBuild, false);
  assertEquals(opts.skipHttp, false);
  assertEquals(opts.timeoutMs, 180_000);
  assertEquals(opts.scheduleWaitSec, 61);
});

Deno.test("test-stack options honor name/stack/flags", () => {
  const opts = resolveTestStackOptions({
    name: "lab",
    stack: "/tmp/lab-stack",
    keep: true,
    skipBuild: true,
    skipHttp: true,
    timeoutSec: 60,
    scheduleWaitSec: 5,
  });
  assertEquals(opts.name, "lab");
  assertEquals(opts.stackRoot, resolve("/tmp/lab-stack"));
  assertEquals(opts.keep, true);
  assertEquals(opts.skipBuild, true);
  assertEquals(opts.skipHttp, true);
  assertEquals(opts.timeoutMs, 60_000);
  assertEquals(opts.scheduleWaitSec, 5);
});

Deno.test("formatTestStackReport summarizes pass/fail and chain note", () => {
  const report: TestStackReport = {
    name: "testbento",
    stackRoot: "/tmp/testbento",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    steps: [
      { id: "docker", title: "Docker daemon available", ok: true },
      { id: "http", title: "HTTP", ok: true, skipped: true, detail: "busy" },
      { id: "app-mysql", title: "MySQL", ok: false, detail: "boom" },
    ],
    passed: 1,
    failed: 1,
    skipped: 1,
    ok: false,
  };
  const text = formatTestStackReport(report);
  assertEquals(text.includes("RESULT: FAIL"), true);
  assertEquals(text.includes("[PASS]"), true);
  assertEquals(text.includes("[SKIP]"), true);
  assertEquals(text.includes("[FAIL]"), true);
  assertEquals(text.includes("ACME"), true);
  assertEquals(text.includes("cron-worker"), true);
  assertEquals(text.includes("permissions"), true);
});
