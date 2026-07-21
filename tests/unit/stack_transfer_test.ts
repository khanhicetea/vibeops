import { assertEquals, assertThrows } from "@std/assert";
import { createEmptyState } from "../../src/domain/state.ts";
import { isBentoError } from "../../src/domain/errors.ts";
import {
  composeProjectName,
  MYSQL_ARCHIVE,
  REDIS_ARCHIVE,
  STACK_ARCHIVE,
  stackVolumeNames,
} from "../../src/services/stack_transfer.ts";

Deno.test("stack transfer has exactly three stable archive names", () => {
  assertEquals([STACK_ARCHIVE, MYSQL_ARCHIVE, REDIS_ARCHIVE], [
    "stack.tar.gz",
    "mysql.tar.gz",
    "redis.tar.gz",
  ]);
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
