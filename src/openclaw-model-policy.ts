/**
 * OpenClaw 2026.8+ moved the model allowlist.
 *
 * Up to 2026.7 the keys of `agents.defaults.models` were the allowlist, and ClawRouter keeps
 * its `blockrun/*` keys there in sync with the models it ships. From 2026.8, OpenClaw's first
 * write to openclaw.json copies those keys into `agents.defaults.modelPolicy.allow`, marks the
 * migration done (`meta.migrations.modelPolicyAllowlist`), and from then on reads only
 * `modelPolicy.allow` whenever it holds an `allow` key (`resolveConfiguredModelPolicyAllow`).
 * Every model ClawRouter adds after that lands in `agents.defaults.models`, which no longer
 * gates anything, so it never reaches the `/model` picker.
 *
 * So the `blockrun/*` entries of `modelPolicy.allow` are kept equal to the ones ClawRouter
 * keeps in `agents.defaults.models`, but only where OpenClaw has already written an `allow`
 * list. That alone proves the running OpenClaw reads it: writing `modelPolicy` into a
 * pre-2026.8 config bricks that OpenClaw, and an absent `allow` means "no restriction",
 * which adding a list would take away.
 */

const BLOCKRUN_PREFIX = "blockrun/";

/** Wildcards that already admit every `blockrun/*` model. */
const COVERING_WILDCARDS = new Set(["*", "blockrun/*"]);

/** The explicit `modelPolicy.allow` array, or undefined when OpenClaw has not written one. */
function explicitAllow(
  defaults: Record<string, unknown>,
): { policy: Record<string, unknown>; allow: unknown[] } | undefined {
  const policy = defaults.modelPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const record = policy as Record<string, unknown>;
  if (!Object.hasOwn(record, "allow") || !Array.isArray(record.allow)) return undefined;
  return { policy: record, allow: record.allow };
}

/** An exact `blockrun/<model>` reference: ClawRouter owns it. Prefix wildcards stay the user's. */
function isOwnedRef(entry: unknown): entry is string {
  if (typeof entry !== "string") return false;
  const ref = entry.trim();
  return ref.startsWith(BLOCKRUN_PREFIX) && !ref.endsWith("*");
}

/**
 * Make the `blockrun/*` entries of `modelPolicy.allow` equal `expectedKeys`: add the missing
 * ones (in `expectedKeys` order, after the existing entries) and drop retired ones. Entries for
 * other providers, wildcards, the deny list and anything that is not a string are left alone.
 */
export function syncBlockrunModelPolicyAllow(
  defaults: Record<string, unknown>,
  expectedKeys: readonly string[],
): { added: number; pruned: number } {
  const found = explicitAllow(defaults);
  if (!found) return { added: 0, pruned: 0 };
  const { policy, allow } = found;
  // An empty list admits every model, as does a wildcard covering BlockRun: nothing to add, and
  // filling an empty list with BlockRun models would lock out every other provider.
  if (
    allow.length === 0 ||
    allow.some((entry) => typeof entry === "string" && COVERING_WILDCARDS.has(entry.trim()))
  ) {
    return { added: 0, pruned: 0 };
  }

  const expected = new Set(expectedKeys);
  const kept = allow.filter((entry) => !isOwnedRef(entry) || expected.has(entry.trim()));
  const present = new Set(kept.filter(isOwnedRef).map((entry) => entry.trim()));
  const missing = expectedKeys.filter((key) => !present.has(key));
  const pruned = allow.length - kept.length;
  if (missing.length > 0 || pruned > 0) policy.allow = [...kept, ...missing];
  return { added: missing.length, pruned };
}

/**
 * Remove every exact `blockrun/*` entry from `modelPolicy.allow`, for uninstall. When nothing
 * else is left the `allow` key goes too. OpenClaw reads an empty list and a missing one alike
 * (every model allowed, as an empty `agents.defaults.models` was), so this only keeps the
 * file from carrying an empty list.
 */
export function removeBlockrunModelPolicyAllow(defaults: Record<string, unknown>): number {
  const found = explicitAllow(defaults);
  if (!found) return 0;
  const { policy, allow } = found;
  const kept = allow.filter((entry) => !isOwnedRef(entry));
  const removed = allow.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length > 0) policy.allow = kept;
  else delete policy.allow;
  return removed;
}
