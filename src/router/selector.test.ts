import { describe, expect, it } from "vitest";

import {
  calculateModelCost,
  filterByExcludeList,
  filterByToolCalling,
  selectModel,
  type ModelPricing,
} from "./selector.js";
import type { TierConfig } from "./types.js";

const TIER_CONFIGS: Record<"SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING", TierConfig> = {
  SIMPLE: { primary: "moonshot/kimi-k2.5", fallback: [] },
  MEDIUM: { primary: "moonshot/kimi-k2.5", fallback: [] },
  COMPLEX: { primary: "moonshot/kimi-k2.5", fallback: [] },
  REASONING: { primary: "moonshot/kimi-k2.5", fallback: [] },
};

const MODEL_PRICING = new Map<string, ModelPricing>([
  ["moonshot/kimi-k2.5", { inputPrice: 0.5, outputPrice: 2.4 }],
  ["anthropic/claude-opus-4.7", { inputPrice: 5, outputPrice: 25 }],
]);

describe("selectModel", () => {
  it("uses claude-opus-4.7 as baseline ID when computing savings", () => {
    const decision = selectModel(
      "SIMPLE",
      0.95,
      "rules",
      "test",
      TIER_CONFIGS,
      MODEL_PRICING,
      1000,
      1000,
    );

    expect(decision.baselineCost).toBeGreaterThan(0);
    expect(decision.savings).toBeGreaterThan(0);
  });
});

describe("filterByToolCalling", () => {
  const supportsToolCalling = (modelId: string) =>
    !["minimax/minimax-m2.5", "nvidia/gpt-oss-120b"].includes(modelId);

  it("removes models without tool calling support when request has tools", () => {
    const models = ["moonshot/kimi-k2.5", "minimax/minimax-m2.5", "deepseek/deepseek-chat"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(["moonshot/kimi-k2.5", "deepseek/deepseek-chat"]);
  });

  it("keeps all models when request has no tools", () => {
    const models = ["moonshot/kimi-k2.5", "minimax/minimax-m2.5", "nvidia/gpt-oss-120b"];
    const filtered = filterByToolCalling(models, false, supportsToolCalling);
    expect(filtered).toEqual(models);
  });

  it("returns original list unchanged when all models support tool calling", () => {
    const models = ["moonshot/kimi-k2.5", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(models);
  });

  it("returns full list unchanged when no models support tool calling, to avoid empty chain", () => {
    const models = ["minimax/minimax-m2.5", "nvidia/gpt-oss-120b"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(models);
  });
});

describe("filterByExcludeList", () => {
  const chain = ["moonshot/kimi-k2.5", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];

  it("removes excluded models from chain", () => {
    const excludeList = new Set(["deepseek/deepseek-chat"]);
    const filtered = filterByExcludeList(chain, excludeList);
    expect(filtered).toEqual(["moonshot/kimi-k2.5", "anthropic/claude-sonnet-4.6"]);
  });

  it("returns original chain if ALL models excluded (safety net)", () => {
    const excludeList = new Set(chain);
    const filtered = filterByExcludeList(chain, excludeList);
    expect(filtered).toEqual(chain);
  });

  it("returns original chain for empty exclude set", () => {
    const filtered = filterByExcludeList(chain, new Set());
    expect(filtered).toEqual(chain);
  });
});

describe("calculateModelCost", () => {
  it("uses claude-opus-4.7 as baseline ID when recomputing fallback costs", () => {
    const costs = calculateModelCost("moonshot/kimi-k2.5", MODEL_PRICING, 1000, 1000);

    expect(costs.baselineCost).toBeGreaterThan(0);
    expect(costs.savings).toBeGreaterThan(0);
  });
});
