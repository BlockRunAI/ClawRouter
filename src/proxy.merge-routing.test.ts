import { describe, expect, it } from "vitest";
import { mergeRoutingConfig, mergeTierRecord } from "./proxy.js";
import { DEFAULT_ROUTING_CONFIG } from "./router/index.js";
import type { Tier, TierConfig } from "./router/index.js";

describe("mergeTierRecord", () => {
  const baseTiers: Record<Tier, TierConfig> = {
    SIMPLE: { primary: "model-a", fallback: ["model-b"] },
    MEDIUM: { primary: "model-c", fallback: [] },
    COMPLEX: { primary: "model-d", fallback: [] },
    REASONING: { primary: "model-e", fallback: [] },
  };

  it("returns base when override is undefined", () => {
    expect(mergeTierRecord(baseTiers, undefined)).toBe(baseTiers);
  });

  it("returns undefined when override is null (disables tier set)", () => {
    expect(mergeTierRecord(baseTiers, null)).toBeUndefined();
  });

  it("shallow-merges override into base", () => {
    const override: Record<Tier, TierConfig> = {
      ...baseTiers,
      SIMPLE: { primary: "custom-model", fallback: ["custom-fallback"] },
    };
    const result = mergeTierRecord(baseTiers, override);
    expect(result!.SIMPLE.primary).toBe("custom-model");
    expect(result!.MEDIUM.primary).toBe("model-c");
  });

  it("returns override when base is undefined", () => {
    const override = baseTiers;
    expect(mergeTierRecord(undefined, override)).toBe(override);
  });
});

describe("mergeRoutingConfig", () => {
  it("returns DEFAULT_ROUTING_CONFIG when no overrides provided", () => {
    expect(mergeRoutingConfig()).toBe(DEFAULT_ROUTING_CONFIG);
    expect(mergeRoutingConfig(undefined)).toBe(DEFAULT_ROUTING_CONFIG);
  });

  it("keeps default agenticTiers when not overridden", () => {
    const result = mergeRoutingConfig({ overrides: DEFAULT_ROUTING_CONFIG.overrides });
    expect(result.agenticTiers).toEqual(DEFAULT_ROUTING_CONFIG.agenticTiers);
  });

  it("disables agenticTiers when set to null", () => {
    const result = mergeRoutingConfig({
      agenticTiers: null as unknown as Record<Tier, TierConfig>,
    });
    expect(result.agenticTiers).toBeUndefined();
  });

  it("merges custom agenticTiers with defaults", () => {
    const customSimple: TierConfig = {
      primary: "custom/agentic-model",
      fallback: ["custom/fallback"],
    };
    const result = mergeRoutingConfig({
      agenticTiers: {
        ...DEFAULT_ROUTING_CONFIG.agenticTiers!,
        SIMPLE: customSimple,
      },
    });
    expect(result.agenticTiers!.SIMPLE).toEqual(customSimple);
    // Other tiers preserved from default
    expect(result.agenticTiers!.COMPLEX).toEqual(
      DEFAULT_ROUTING_CONFIG.agenticTiers!.COMPLEX,
    );
  });

  it("disables ecoTiers when set to null", () => {
    const result = mergeRoutingConfig({
      ecoTiers: null as unknown as Record<Tier, TierConfig>,
    });
    expect(result.ecoTiers).toBeUndefined();
  });

  it("merges custom ecoTiers with defaults", () => {
    const customMedium: TierConfig = {
      primary: "custom/eco-model",
      fallback: [],
    };
    const result = mergeRoutingConfig({
      ecoTiers: {
        ...DEFAULT_ROUTING_CONFIG.ecoTiers!,
        MEDIUM: customMedium,
      },
    });
    expect(result.ecoTiers!.MEDIUM).toEqual(customMedium);
    expect(result.ecoTiers!.SIMPLE).toEqual(DEFAULT_ROUTING_CONFIG.ecoTiers!.SIMPLE);
  });

  it("merges custom premiumTiers with defaults", () => {
    const customComplex: TierConfig = {
      primary: "custom/premium-model",
      fallback: ["custom/premium-fallback"],
    };
    const result = mergeRoutingConfig({
      premiumTiers: {
        ...DEFAULT_ROUTING_CONFIG.premiumTiers!,
        COMPLEX: customComplex,
      },
    });
    expect(result.premiumTiers!.COMPLEX).toEqual(customComplex);
    expect(result.premiumTiers!.SIMPLE).toEqual(
      DEFAULT_ROUTING_CONFIG.premiumTiers!.SIMPLE,
    );
  });

  it("disables premiumTiers when set to null", () => {
    const result = mergeRoutingConfig({
      premiumTiers: null as unknown as Record<Tier, TierConfig>,
    });
    expect(result.premiumTiers).toBeUndefined();
  });

  it("still merges other fields correctly alongside tier overrides", () => {
    const result = mergeRoutingConfig({
      agenticTiers: null as unknown as Record<Tier, TierConfig>,
      overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, agenticMode: true },
    });
    expect(result.agenticTiers).toBeUndefined();
    expect(result.overrides.agenticMode).toBe(true);
    expect(result.tiers).toEqual(DEFAULT_ROUTING_CONFIG.tiers);
  });
});
