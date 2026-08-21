/**
 * Guard: the router must never fall back to a free model that is dead upstream.
 *
 * This exists because of a concrete regression. `free/seed-oss-36b` went HTTP 410
 * EOL at NVIDIA on 2026-08-03. ClawRouter dropped it from the picker and the
 * FREE_MODELS cascade in v0.12.241, but the routing tiers now live in the
 * separately-versioned @blockrun/router-core, so a stale build put the dead model
 * back into three fallback chains with every product-side surface already correct.
 *
 * That matters beyond a wasted hop: BlockRun server-redirects retired free ids, so
 * routing to one SILENTLY DEFEATS `/exclude` — the caller excludes a model, the
 * router hands it the request anyway, and the gateway answers from the redirect
 * target. The 713 tests in this repo did not catch it, because router selection
 * coverage moved out of the repo along with the code.
 *
 * The allowed set is DERIVED, not hard-coded: it follows `src/top-models.json`, so
 * a future free-tier resync updates this guard for free. Adding a model here by
 * hand is the wrong fix — update the picker instead.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_ROUTING_CONFIG } from "@blockrun/router-core";
import topModels from "../top-models.json" with { type: "json" };

/**
 * The free tier spans two namespaces: the picker lists `free/*` ids while the
 * gateway's public catalog (and router-core's chains, since 9386c53) use
 * `nvidia/*` for the same models. Liveness is therefore judged on the BASENAME:
 * a chain id is live if the picker carries the same model under either prefix.
 *
 * The gpt-oss-120b/20b allowlist that used to sit here is gone: those ids were
 * "hidden but served" until they weren't — the gateway answers 400 Unknown
 * model for both (probed 2026-08-21). An allowlist of dead ids would wave the
 * exact regression this suite exists to catch.
 */
const FREE_PREFIX = /^(?:free|nvidia)\//;

const liveFreeBasenames = new Set<string>(
  (topModels as string[])
    .filter((id) => FREE_PREFIX.test(id))
    .map((id) => id.split("/", 2)[1]),
);

type TierConfig = { primary?: string; fallback?: string[] };

/** Every tier container in the config: auto, eco, premium, agentic. */
function tierContainers(): Record<string, Record<string, TierConfig>> {
  const cfg = DEFAULT_ROUTING_CONFIG as unknown as Record<string, unknown>;
  const out: Record<string, Record<string, TierConfig>> = {};
  for (const key of Object.keys(cfg)) {
    if (!/tiers$/i.test(key)) continue;
    const value = cfg[key];
    if (value && typeof value === "object") {
      out[key] = value as Record<string, TierConfig>;
    }
  }
  return out;
}

/** [profileKey.tier.position, modelId] for every free/* id the router can serve. */
function freeModelReferences(): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  for (const [profileKey, tiers] of Object.entries(tierContainers())) {
    for (const [tierName, tier] of Object.entries(tiers)) {
      if (tier?.primary && FREE_PREFIX.test(tier.primary)) {
        refs.push([`${profileKey}.${tierName}.primary`, tier.primary]);
      }
      (tier?.fallback ?? []).forEach((model, i) => {
        if (FREE_PREFIX.test(model)) {
          refs.push([`${profileKey}.${tierName}.fallback[${i}]`, model]);
        }
      });
    }
  }
  return refs;
}

describe("router free-model liveness", () => {
  it("finds tier containers to check (guards against a silent no-op)", () => {
    // If the config shape changes upstream and this stops finding tiers, the whole
    // suite would pass vacuously. Fail loudly instead.
    expect(Object.keys(tierContainers()).length).toBeGreaterThan(0);
    expect(freeModelReferences().length).toBeGreaterThan(0);
  });

  it("never routes to a free model that is absent from the live picker", () => {
    const dead = freeModelReferences().filter(
      ([, model]) => !liveFreeBasenames.has(model.split("/", 2)[1]),
    );

    expect(
      dead,
      dead.length === 0
        ? ""
        : `Router can serve free models that are no longer live:\n` +
            dead.map(([where, model]) => `  ${where} -> ${model}`).join("\n") +
            `\n\nLive basenames (from src/top-models.json):\n` +
            `  ${[...liveFreeBasenames].join("\n  ")}\n\n` +
            `If a model was retired upstream, remove it from the router tiers in ` +
            `@blockrun/router-core and re-pin. Do NOT add it to this test.`,
    ).toEqual([]);
  });

  it("specifically excludes seed-oss-36b, retired 2026-08-03", () => {
    // Named regression: this is the exact id that came back through a stale build.
    const seedOss = freeModelReferences().filter(([, m]) => m.includes("seed-oss"));
    expect(seedOss).toEqual([]);
  });
});
