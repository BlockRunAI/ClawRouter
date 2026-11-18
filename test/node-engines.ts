/**
 * Node version floors, read from `engines.node`.
 *
 * Shared by `vitest.config.ts` (refuse to run on a Node the package does not
 * support) and `test/engines-floor.test.ts` (the package's floor must cover the
 * floor of every runtime dependency tsup bundles into dist).
 *
 * Only plain lower bounds are understood (">=22", ">= 20.19.0", ">=22.19.0").
 * Anything else returns null so the caller can fail loudly instead of guessing.
 */

export type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** The minimum version a `>=X[.Y[.Z]]` range admits, or null for any other shape. */
export function rangeFloor(range: string): Version | null {
  const match = /^>=\s*(\S+)$/.exec(range.trim());
  return match ? parseVersion(match[1]) : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function formatVersion(v: Version): string {
  return v.join(".");
}
