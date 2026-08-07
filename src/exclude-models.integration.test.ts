import { describe, it, expect } from "vitest";
import { DEFAULT_ROUTING_CONFIG, filterByExcludeList, getFallbackChain } from "./router/index.js";

describe("excludeModels integration", () => {
  it("filters nvidia/gpt-oss-120b from eco SIMPLE chain", () => {
    const chain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.ecoTiers!);
    const excluded = new Set(["nvidia/gpt-oss-120b"]);
    const filtered = filterByExcludeList(chain, excluded);

    expect(filtered).not.toContain("nvidia/gpt-oss-120b");
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("excludes multiple models across all eco tiers", () => {
    const exclude = new Set(["nvidia/gpt-oss-120b", "xai/grok-4-0709"]);

    for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const) {
      const chain = getFallbackChain(tier, DEFAULT_ROUTING_CONFIG.ecoTiers!);
      const filtered = filterByExcludeList(chain, exclude);
      for (const model of exclude) {
        if (chain.includes(model)) {
          expect(filtered).not.toContain(model);
        }
      }
      expect(filtered.length).toBeGreaterThan(0);
    }
  });

  it("gracefully handles excluding ALL models in a tier (safety net)", () => {
    const chain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.ecoTiers!);
    const excludeAll = new Set(chain);
    const filtered = filterByExcludeList(chain, excludeAll);
    expect(filtered).toEqual(chain);
  });

  it("works across auto tiers too", () => {
    const exclude = new Set(["nvidia/gpt-oss-120b"]);
    const chain = getFallbackChain("SIMPLE", DEFAULT_ROUTING_CONFIG.tiers);
    const filtered = filterByExcludeList(chain, exclude);

    if (chain.includes("nvidia/gpt-oss-120b")) {
      expect(filtered).not.toContain("nvidia/gpt-oss-120b");
    }
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("empty exclude list returns chain unchanged", () => {
    const chain = getFallbackChain("COMPLEX", DEFAULT_ROUTING_CONFIG.tiers);
    const filtered = filterByExcludeList(chain, new Set());
    expect(filtered).toEqual(chain);
  });
});
