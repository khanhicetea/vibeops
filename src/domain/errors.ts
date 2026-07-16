/** Typed domain and operational errors with recovery hints. */

export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PERMISSION"
  | "STATE"
  | "RENDER"
  | "SERVICE"
  | "SECRET"
  | "SAFETY"
  | "PLATFORM"
  | "MIGRATION"
  | "TIMEOUT"
  | "INTERNAL";

export class BentoError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;
  readonly exitCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: {
      recovery?: string;
      details?: Record<string, unknown>;
      exitCode?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BentoError";
    this.code = code;
    this.recovery = opts?.recovery;
    this.details = opts?.details;
    this.exitCode = opts?.exitCode ?? defaultExitCode(code);
  }
}

function defaultExitCode(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION":
      return 2;
    case "NOT_FOUND":
      return 3;
    case "CONFLICT":
      return 4;
    case "PERMISSION":
      return 5;
    case "STATE":
      return 6;
    case "RENDER":
      return 7;
    case "SERVICE":
      return 8;
    case "SECRET":
      return 9;
    case "SAFETY":
      return 10;
    case "PLATFORM":
      return 11;
    case "MIGRATION":
      return 12;
    case "TIMEOUT":
      return 13;
    case "INTERNAL":
      return 1;
  }
}

export function isBentoError(err: unknown): err is BentoError {
  return err instanceof BentoError;
}

export function validationError(
  message: string,
  details?: Record<string, unknown>,
): BentoError {
  return new BentoError("VALIDATION", message, {
    details,
    recovery: "Correct the invalid input and retry.",
  });
}

export function notFoundError(message: string): BentoError {
  return new BentoError("NOT_FOUND", message, {
    recovery: "Verify the resource name and current desired state.",
  });
}

export function conflictError(message: string, recovery?: string): BentoError {
  return new BentoError("CONFLICT", message, {
    recovery: recovery ?? "Resolve the conflict in desired state and retry.",
  });
}

export function safetyError(message: string, recovery?: string): BentoError {
  return new BentoError("SAFETY", message, {
    recovery: recovery ??
      "This operation is intentionally blocked. Use an explicit safe alternative.",
  });
}

export function stateError(
  message: string,
  recoveryOrOpts?: string | { recovery?: string },
): BentoError {
  const recovery = typeof recoveryOrOpts === "string" ? recoveryOrOpts : recoveryOrOpts?.recovery;
  return new BentoError("STATE", message, {
    recovery: recovery ??
      "Inspect state.json and restore from a known-good backup if needed.",
  });
}

export function renderError(message: string, cause?: unknown): BentoError {
  return new BentoError("RENDER", message, {
    cause,
    recovery: "Previous generation should remain live. Fix the error and re-render.",
  });
}

export function platformError(message: string, cause?: unknown): BentoError {
  return new BentoError("PLATFORM", message, {
    cause,
    recovery: "Check Docker, filesystem permissions, and Deno capability grants.",
  });
}
