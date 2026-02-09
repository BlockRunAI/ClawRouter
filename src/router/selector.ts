/**
 * Tier → Model Selection
 *
 * Maps a classification tier to the cheapest capable model.
 * Builds RoutingDecision metadata with cost estimates and savings.
 */

import type { Tier, TierConfig, RoutingDecision } from "./types.js";

export type ModelPricing = {
  inputPrice: number; // per 1M tokens
  outputPrice: number; // per 1M tokens
};

/**
 * Select the primary model for a tier and build the RoutingDecision.
 */
export function selectModel(
  tier: Tier,
  confidence: number,
  method: "rules" | "llm",
  reasoning: string,
  tierConfigs: Record<Tier, TierConfig>,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): RoutingDecision {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);

  const inputCost = pricing ? (estimatedInputTokens / 1_000_000) * pricing.inputPrice : 0;
  const outputCost = pricing ? (maxOutputTokens / 1_000_000) * pricing.outputPrice : 0;
  const costEstimate = inputCost + outputCost;

  // Baseline: what Claude Opus would cost (the premium default)
  const opusPricing = modelPricing.get("anthropic/claude-opus-4");
  const baselineInput = opusPricing
    ? (estimatedInputTokens / 1_000_000) * opusPricing.inputPrice
    : 0;
  const baselineOutput = opusPricing ? (maxOutputTokens / 1_000_000) * opusPricing.outputPrice : 0;
  const baselineCost = baselineInput + baselineOutput;

  const savings = baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;

  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings,
  };
}

/**
 * Get the ordered fallback chain for a tier: [primary, ...fallbacks].
 */
export function getFallbackChain(tier: Tier, tierConfigs: Record<Tier, TierConfig>): string[] {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}

/**
 * Get the fallback chain filtered by context length.
 * Only returns models that can handle the estimated total context.
 *
 * @param tier - The tier to get fallback chain for
 * @param tierConfigs - Tier configurations
 * @param estimatedTotalTokens - Estimated total context (input + output)
 * @param getContextWindow - Function to get context window for a model ID
 * @returns Filtered list of models that can handle the context
 */
export function getFallbackChainFiltered(
  tier: Tier,
  tierConfigs: Record<Tier, TierConfig>,
  estimatedTotalTokens: number,
  getContextWindow: (modelId: string) => number | undefined,
): string[] {
  const fullChain = getFallbackChain(tier, tierConfigs);

  // Filter to models that can handle the context
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === undefined) {
      // Unknown model - include it (let API reject if needed)
      return true;
    }
    // Add 10% buffer for safety
    return contextWindow >= estimatedTotalTokens * 1.1;
  });

  // If all models filtered out, return the original chain
  // (let the API error out - better than no options)
  if (filtered.length === 0) {
    return fullChain;
  }

  return filtered;
}
