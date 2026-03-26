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

const BASELINE_MODEL_ID = "anthropic/claude-opus-4.6";

// Hardcoded fallback: Claude Opus 4.6 pricing (per 1M tokens)
// Used when baseline model not found in dynamic pricing map
const BASELINE_INPUT_PRICE = 5.0;
const BASELINE_OUTPUT_PRICE = 25.0;

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
  routingProfile?: "free" | "eco" | "auto" | "premium",
  agenticScore?: number,
): RoutingDecision {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);

  // Defensive: guard against undefined price fields (not just undefined pricing)
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = (estimatedInputTokens / 1_000_000) * inputPrice;
  const outputCost = (maxOutputTokens / 1_000_000) * outputPrice;
  const costEstimate = inputCost + outputCost;

  // Baseline: what Claude Opus 4.5 would cost (the premium reference)
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = (estimatedInputTokens / 1_000_000) * opusInputPrice;
  const baselineOutput = (maxOutputTokens / 1_000_000) * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;

  // Premium profile doesn't calculate savings (it's about quality, not cost)
  const savings =
    routingProfile === "premium"
      ? 0
      : baselineCost > 0
        ? Math.max(0, (baselineCost - costEstimate) / baselineCost)
        : 0;

  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings,
    ...(agenticScore !== undefined && { agenticScore }),
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
 * Calculate cost for a specific model (used when fallback model is used).
 * Returns updated cost fields for RoutingDecision.
 */
// Server-side margin applied to all x402 payments (must match blockrun server's MARGIN_PERCENT)
const SERVER_MARGIN_PERCENT = 5;
// Minimum payment enforced by CDP Facilitator (must match blockrun server's MIN_PAYMENT_USD)
const MIN_PAYMENT_USD = 0.001;

export function calculateModelCost(
  model: string,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  routingProfile?: "free" | "eco" | "auto" | "premium",
): { costEstimate: number; baselineCost: number; savings: number } {
  const pricing = modelPricing.get(model);

  // Defensive: guard against undefined price fields (not just undefined pricing)
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = (estimatedInputTokens / 1_000_000) * inputPrice;
  const outputCost = (maxOutputTokens / 1_000_000) * outputPrice;
  // Include server margin + minimum payment to match actual x402 charge
  const costEstimate = Math.max(
    (inputCost + outputCost) * (1 + SERVER_MARGIN_PERCENT / 100),
    MIN_PAYMENT_USD,
  );

  // Baseline: what Claude Opus 4.5 would cost (the premium reference)
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = (estimatedInputTokens / 1_000_000) * opusInputPrice;
  const baselineOutput = (maxOutputTokens / 1_000_000) * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;

  // Premium profile doesn't calculate savings (it's about quality, not cost)
  const savings =
    routingProfile === "premium"
      ? 0
      : baselineCost > 0
        ? Math.max(0, (baselineCost - costEstimate) / baselineCost)
        : 0;

  return { costEstimate, baselineCost, savings };
}

/**
 * Filter a model list to only those that support tool calling.
 * When hasTools is false, returns the list unchanged.
 * When all models lack tool calling support, returns the full list as a fallback
 * (better to let the API error than produce an empty chain).
 */
export function filterByToolCalling(
  models: string[],
  hasTools: boolean,
  supportsToolCalling: (modelId: string) => boolean,
): string[] {
  if (!hasTools) return models;
  const filtered = models.filter(supportsToolCalling);
  return filtered.length > 0 ? filtered : models;
}

/**
 * Filter a model list to only those that support vision (image inputs).
 * When hasVision is false, returns the list unchanged.
 * When all models lack vision support, returns the full list as a fallback
 * (better to let the API error than produce an empty chain).
 */
export function filterByVision(
  models: string[],
  hasVision: boolean,
  supportsVision: (modelId: string) => boolean,
): string[] {
  if (!hasVision) return models;
  const filtered = models.filter(supportsVision);
  return filtered.length > 0 ? filtered : models;
}

/**
 * Filter a model list to remove user-excluded models.
 * When all models are excluded, returns the full list as a fallback
 * (same safety pattern as filterByToolCalling/filterByVision).
 */
export function filterByExcludeList(models: string[], excludeList: Set<string>): string[] {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((m) => !excludeList.has(m));
  return filtered.length > 0 ? filtered : models;
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
