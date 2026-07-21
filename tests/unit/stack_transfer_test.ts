import { assertEquals, assertThrows } from "@std/assert";
import { createEmptyState } from "../../src/domain/state.ts";
import { isBentoError } from "../../src/domain/errors.ts";
import {
  composeProjectName,
  REDIS_ARCHIVE,
  STACK_ARCHIVE,
  stackVolumeNames,
  volumeArchiveName,
} from "../../src/services/stack_transfer.ts";

Deno.test("stack transfer names every archive after its logical volume", () => {
  assertEquals(STACK_ARCHIVE, "stack.tar.gz");
  assertEquals(volumeArchiveName("mysql84-data"), "mysql84-data.tar.gz");
  assertEquals(volumeArchiveName("mysql80-data"), "mysql80-data.tar.gz");
  assertEquals(volumeArchiveName("redis-data"), REDIS_ARCHIVE);
  assertThrows(() => volumeArchiveName("../escape"), Error, "invalid Docker volume name");
});

Deno.test("stack transfer derives Docker volume names from imported project and state", () => {
  const state = createEmptyState();
  const names = stackVolumeNames(state, "customer-stack");
  assertEquals(names.mysql, [
    { logical: "mysql84-data", docker: "customer-stack_mysql84-data" },
  ]);
  assertEquals(names.redis, {
    logical: "redis-data",
    docker: "customer-stack_redis-data",
  });
});

Deno.test("stack transfer validates compose project names", () => {
  assertEquals(composeProjectName({}), "bento");
  assertEquals(composeProjectName({ COMPOSE_PROJECT_NAME: "prod_1" }), "prod_1");
  const err = assertThrows(
    () => composeProjectName({ COMPOSE_PROJECT_NAME: "Bad Project" }),
    Error,
    "invalid COMPOSE_PROJECT_NAME",
  );
  assertEquals(isBentoError(err) && err.code === "VALIDATION", true);
});
