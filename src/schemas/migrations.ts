/**
 * Desired-state schema migration chain.
 *
 * Rules:
 * - Future schemaVersion is rejected before any write (see parseDesiredState).
 * - Supported older versions migrate deterministically through typed steps.
 * - Migrations are pure functions: (unknown) -> unknown; branding happens after.
 * - Callers that persist must backup the prior document before writing migrated state.
 * - No-op reads must not rewrite disk (StateStore.load does not save).
 */

import { STATE_SCHEMA_VERSION } from "../version.ts";
import { stateError, validationError } from "../domain/errors.ts";

export type MigrationStep = {
  from: number;
  to: number;
  name: string;
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Ordered migration steps. Add `migrateV1toV2` etc. when STATE_SCHEMA_VERSION bumps.
 * Keep steps pure and deterministic.
 */
export const MIGRATION_CHAIN: MigrationStep[] = [
  {
    from: 1,
    to: 2,
    name: "proxy-multiple-upstreams",
    migrate: migrateV1toV2,
  },
];

/**
 * Apply the migration chain from `schemaVersion` up to STATE_SCHEMA_VERSION.
 * Returns the migrated object (still unbranded) and whether any step ran.
 */
export function migrateStateDocument(
  raw: unknown,
): { value: Record<string, unknown>; migrated: boolean; fromVersion: number } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw validationError("state must be a JSON object");
  }
  const doc = { ...(raw as Record<string, unknown>) };
  const schemaVersion = doc.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw validationError("schemaVersion must be an integer");
  }
  if (schemaVersion > STATE_SCHEMA_VERSION) {
    throw stateError(
      `state schemaVersion ${schemaVersion} is newer than supported ${STATE_SCHEMA_VERSION}; upgrade Bento`,
      {
        recovery: "Install a Bento release that supports this state version.",
      },
    );
  }
  if (schemaVersion < 1) {
    throw validationError(`unsupported schemaVersion ${schemaVersion}`);
  }

  let current = schemaVersion;
  let migrated = false;
  let value = doc;

  while (current < STATE_SCHEMA_VERSION) {
    const step = MIGRATION_CHAIN.find((s) => s.from === current);
    if (!step) {
      throw stateError(
        `no migration path from schemaVersion ${current} to ${STATE_SCHEMA_VERSION}`,
        {
          recovery: "Restore state from backup or upgrade Bento with the missing migration.",
        },
      );
    }
    value = step.migrate(value);
    value = { ...value, schemaVersion: step.to };
    current = step.to;
    migrated = true;
  }

  return { value, migrated, fromVersion: schemaVersion };
}

/** Convert each v1 proxy's single upstream into the v2 upstream list. */
export function migrateV1toV2(raw: Record<string, unknown>): Record<string, unknown> {
  const proxies = raw.proxies && typeof raw.proxies === "object" && !Array.isArray(raw.proxies)
    ? Object.fromEntries(
      Object.entries(raw.proxies as Record<string, unknown>).map(([name, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [name, value];
        const proxy = value as Record<string, unknown>;
        const { upstream, ...rest } = proxy;
        return [name, {
          ...rest,
          upstreams: Array.isArray(proxy.upstreams)
            ? proxy.upstreams
            : typeof upstream === "string"
            ? [upstream]
            : [],
        }];
      }),
    )
    : raw.proxies;

  return { ...raw, proxies, schemaVersion: 2 };
}

/** Backup filename helper for pre-migration snapshots. */
export function migrationBackupName(fromVersion: number, nowIso: string): string {
  const safe = nowIso.replace(/[:.]/g, "-");
  return `state.v${fromVersion}.pre-migrate.${safe}.json`;
}
