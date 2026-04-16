import { describe, expect, it } from "vitest";
import { buildCostBreakdown } from "./proxy.js";
import type { ModelPricing } from "./router/index.js";

// Minimal pricing map covering the models used in these tests.
// Prices are per 1M tokens, matching the real BLOCKRUN_MODELS table shape.
const pricing = new Map<string, ModelPricing>([
  // Baseline (Opus 4.7) — high cost so savings show up
  ["anthropic/claude-opus-4.7", { inputPrice: 15, outputPrice: 75 }],
  // Cheap middle model
  ["google/gemini-2.5-flash", { inputPrice: 0.15, outputPrice: 0.6 }],
  // Free model
  ["free/glm-4.7", { inputPrice: 0, outputPrice: 0 }],
  // Premium model (cost ~= baseline so savings_pct ≈ 0)
  ["anthropic/claude-opus-4.7-premium", { inputPrice: 15, outputPrice: 75 }],
]);

describe("buildCostBreakdown", () => {
  it("returns undefined when token counts are missing", () => {
    expect(
      buildCostBreakdown({
        actualModelUsed: "google/gemini-2.5-flash",
        routingProfile: "auto",
        routingDecision: { tier: "SIMPLE" },
        modelPricing: pricing,
        inputTokens: undefined,
        outputTokens: 100,
        tier: "SIMPLE",
      }),
    ).toBeUndefined();

    expect(
      buildCostBreakdown({
        actualModelUsed: "google/gemini-2.5-flash",
        routingProfile: "auto",
        routingDecision: { tier: "SIMPLE" },
        modelPricing: pricing,
        inputTokens: 100,
        outputTokens: undefined,
        tier: "SIMPLE",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for negative token counts", () => {
    expect(
      buildCostBreakdown({
        actualModelUsed: "google/gemini-2.5-flash",
        routingProfile: "auto",
        routingDecision: { tier: "SIMPLE" },
        modelPricing: pricing,
        inputTokens: -1,
        outputTokens: 100,
        tier: "SIMPLE",
      }),
    ).toBeUndefined();
  });

  it("computes input and output cost from actual tokens × model price", () => {
    // 1M input tokens × $0.15 = $0.15
    // 2M output tokens × $0.60 = $1.20
    const result = buildCostBreakdown({
      actualModelUsed: "google/gemini-2.5-flash",
      routingProfile: "auto",
      routingDecision: { tier: "SIMPLE" },
      modelPricing: pricing,
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      tier: "SIMPLE",
    });

    expect(result).toBeDefined();
    expect(result!.input).toBeCloseTo(0.15, 4);
    expect(result!.output).toBeCloseTo(1.2, 4);
    // total includes server margin (5%) so it's slightly higher than input+output
    expect(result!.total).toBeGreaterThan(1.35);
    expect(result!.total).toBeLessThan(1.5);
  });

  it("computes baseline against the reference model and savings_pct for auto profile", () => {
    // Using flash for 100k input / 200k output tokens
    const result = buildCostBreakdown({
      actualModelUsed: "google/gemini-2.5-flash",
      routingProfile: "auto",
      routingDecision: { tier: "SIMPLE" },
      modelPricing: pricing,
      inputTokens: 100_000,
      outputTokens: 200_000,
      tier: "SIMPLE",
    });

    expect(result).toBeDefined();
    // Baseline (Opus @ $15/$75) should be massively more expensive than flash
    expect(result!.baseline).toBeGreaterThan(result!.total);
    // Savings should be high (flash is ~100x cheaper per token than opus)
    expect(result!.savings_pct).toBeDefined();
    expect(result!.savings_pct!).toBeGreaterThan(90);
    expect(result!.savings_pct!).toBeLessThanOrEqual(100);
  });

  it("omits savings_pct for premium profile", () => {
    const result = buildCostBreakdown({
      actualModelUsed: "anthropic/claude-opus-4.7",
      routingProfile: "premium",
      routingDecision: { tier: "REASONING" },
      modelPricing: pricing,
      inputTokens: 10_000,
      outputTokens: 20_000,
      tier: "REASONING",
    });

    expect(result).toBeDefined();
    expect(result!.savings_pct).toBeUndefined();
  });

  it("includes model and tier metadata fields", () => {
    const result = buildCostBreakdown({
      actualModelUsed: "free/glm-4.7",
      routingProfile: "free",
      routingDecision: { tier: "SIMPLE" },
      modelPricing: pricing,
      inputTokens: 100,
      outputTokens: 200,
      tier: "SIMPLE",
    });

    expect(result).toBeDefined();
    expect(result!.model).toBe("free/glm-4.7");
    expect(result!.tier).toBe("SIMPLE");
  });

  it("omits tier when not provided", () => {
    const result = buildCostBreakdown({
      actualModelUsed: "google/gemini-2.5-flash",
      routingProfile: "auto",
      routingDecision: undefined,
      modelPricing: pricing,
      inputTokens: 100,
      outputTokens: 200,
      tier: undefined,
    });

    expect(result).toBeDefined();
    expect(result!.tier).toBeUndefined();
  });

  it("handles free model with zero pricing gracefully", () => {
    // Free models: input+output cost is 0, but total has MIN_PAYMENT_USD floor
    // from calculateModelCost. That's fine — the cost fields still render.
    const result = buildCostBreakdown({
      actualModelUsed: "free/glm-4.7",
      routingProfile: "free",
      routingDecision: { tier: "SIMPLE" },
      modelPricing: pricing,
      inputTokens: 100_000,
      outputTokens: 200_000,
      tier: "SIMPLE",
    });

    expect(result).toBeDefined();
    expect(result!.input).toBe(0);
    expect(result!.output).toBe(0);
    // baseline is Opus so it's > 0
    expect(result!.baseline).toBeGreaterThan(0);
    // savings near 100% (free vs opus)
    expect(result!.savings_pct!).toBeGreaterThanOrEqual(99);
  });

  it("total and baseline have consistent server margin applied", () => {
    // Both total and baseline come from calculateModelCost, which applies
    // the same SERVER_MARGIN_PERCENT and MIN_PAYMENT_USD floor. So the
    // comparison is apples-to-apples.
    const result = buildCostBreakdown({
      actualModelUsed: "google/gemini-2.5-flash",
      routingProfile: "auto",
      routingDecision: { tier: "SIMPLE" },
      modelPricing: pricing,
      inputTokens: 500_000,
      outputTokens: 500_000,
      tier: "SIMPLE",
    });

    expect(result).toBeDefined();
    // Savings calculation stays consistent: 1 - (total / baseline)
    const implied = 1 - result!.total / result!.baseline;
    expect(result!.savings_pct!).toBeCloseTo(Math.round(implied * 100), 0);
  });
});
