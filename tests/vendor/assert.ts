/** Minimal assert helpers for tests without JSR. */

export function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      msg ??
        `Values are not equal.\n    actual: ${preview(actual)}\n  expected: ${preview(expected)}`,
    );
  }
}

export function assertThrows(
  fn: () => unknown,
  // deno-lint-ignore no-explicit-any
  ErrorClass?: new (...args: any[]) => Error,
  msgIncludes?: string,
): Error {
  try {
    fn();
  } catch (e) {
    if (ErrorClass && !(e instanceof ErrorClass)) {
      throw new Error(`expected ${ErrorClass.name}, got ${e}`);
    }
    if (msgIncludes && (!(e instanceof Error) || !e.message.includes(msgIncludes))) {
      throw new Error(
        `expected message to include ${JSON.stringify(msgIncludes)}, got ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("Expected function to throw");
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  // deno-lint-ignore no-explicit-any
  ErrorClass?: new (...args: any[]) => Error,
  msgIncludes?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    if (ErrorClass && !(e instanceof ErrorClass)) {
      throw new Error(`expected ${ErrorClass.name}, got ${e}`);
    }
    if (msgIncludes && (!(e instanceof Error) || !e.message.includes(msgIncludes))) {
      throw new Error(
        `expected message to include ${JSON.stringify(msgIncludes)}, got ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("Expected promise to reject");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (!deepEqual(ak, bk)) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    );
  }
  return false;
}

function preview(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
