/**
 * Guard: every model the router can pick must exist in ClawRouter's own catalog.
 *
 * This is a cost-cap guard, not a tidiness one. `estimateAmount()` looks the
 * model up in BLOCKRUN_MODELS and returns `undefined` when it is absent, and
 * both consumers of that value fail OPEN:
 *
 *   proxy.ts  modelsToTry filter   `if (!est) return true;  // permissive`
 *   proxy.ts  success accounting   `if (costEst) addSessionCost(...)`
 *
 * So a routing target we do not carry is never filtered by `maxCostPerRun` and
 * never accumulates into the session's spend — it bills the user off-books.
 *
 * That is not hypothetical. router-core V3.5 made `zai/glm-5.3-flash` the eco
 * MEDIUM and COMPLEX primary while ClawRouter's catalog had no entry for it, so
 * every eco user with a cost cap set had no cap on their primary model until
 * v0.12.258. Nothing failed; the money just stopped being counted.
 *
 * Alias resolution counts as carrying the model — that is how the free tier's
 * `nvidia/* -> free/*` bridges work — but the id must land on a real entry.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_ROUTING_CONFIG } from "@blockrun/router-core";

import { BLOCKRUN_MODELS, MODEL_ALIASES } from "../models.js";

const catalogIds = new Set(BLOCKRUN_MODELS.map((m) => m.id));

/** Does this id reach a catalog entry, directly or through one alias hop? */
function resolvesToCatalogEntry(id: string): boolean {
  if (catalogIds.has(id)) return true;
  const aliased = MODEL_ALIASES[id];
  return aliased !== undefined && catalogIds.has(aliased);
}

type TierConfig = { primary?: string; fallback?: string[] };

/** [profileKey.tier.position, modelId] for every model the router can serve. */
function chainReferences(): Array<[string, string]> {
  const cfg = DEFAULT_ROUTING_CONFIG as unknown as Record<string, unknown>;
  const refs: Array<[string, string]> = [];
  for (const key of Object.keys(cfg)) {
    if (!/tiers$/i.test(key)) continue;
    const table = cfg[key];
    if (!table || typeof table !== "object") continue;
    for (const [tierName, tier] of Object.entries(table as Record<string, TierConfig>)) {
      if (tier?.primary) refs.push([`${key}.${tierName}.primary`, tier.primary]);
      (tier?.fallback ?? []).forEach((model, i) => {
        refs.push([`${key}.${tierName}.fallback[${i}]`, model]);
      });
    }
  }
  return refs;
}

describe("router chain models are in the local catalog", () => {
  it("finds chain references to check (guards against a vacuous pass)", () => {
    // If the upstream config shape changes and this stops finding tiers, the
    // whole suite would pass having checked nothing. Fail loudly instead.
    expect(chainReferences().length).toBeGreaterThan(0);
  });

  it("can price every model the router is allowed to pick", () => {
    const uncatalogued = chainReferences().filter(([, model]) => !resolvesToCatalogEntry(model));

    expect(
      uncatalogued,
      uncatalogued.length === 0
        ? ""
        : `The router can pick models ClawRouter cannot price, which means they ` +
            `bypass maxCostPerRun and never accumulate into session cost:\n` +
            uncatalogued.map(([where, model]) => `  ${where} -> ${model}`).join("\n") +
            `\n\nAdd the missing entries to BLOCKRUN_MODELS in src/models.ts ` +
            `(mirroring blockrun's src/lib/models.ts). Do NOT silence this by ` +
            `removing the model from the router — the router is downstream of ` +
            `blockrun's catalog, this repo is what has to catch up.`,
    ).toEqual([]);
  });
});
