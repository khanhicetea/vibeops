/** Bento version and build metadata. */
export const BENTO_VERSION = "0.1.0";
export const DENO_TARGET_VERSION = "2.9.3";
export const STATE_SCHEMA_VERSION = 3 as const;
export const ASSET_VERSION = "0.1.0";

export function versionBanner(): string {
  return `bento ${BENTO_VERSION} (deno ${DENO_TARGET_VERSION})`;
}
