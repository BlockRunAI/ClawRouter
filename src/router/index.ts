/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * 100% local — rules-based scoring handles all requests in <1ms.
 * Ambiguous cases default to configurable tier (MEDIUM by default).
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types.js";
import { classifyByRules } from "./rules.js";
import { selectModel, type ModelPricing } from "./selector.js";

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing: Map<string, ModelPricing>;
};

/**
 * Route a request to the cheapest capable model.
 *
 * 1. Check overrides (large context, structured output)
 * 2. Run rule-based classifier (14 weighted dimensions, <1ms)
 * 3. If ambiguous, default to configurable tier (no external API calls)
 * 4. Select model for tier
 * 5. Return RoutingDecision with metadata
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const { config, modelPricing } = options;

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);

  // --- Rule-based classification (runs first to get agenticScore) ---
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);

  // Determine if agentic tiers should be used:
  // 1. Explicit agenticMode config OR
  // 2. Auto-detected agentic task (agenticScore >= 0.6)
  const agenticScore = ruleResult.agenticScore ?? 0;
  const isAutoAgentic = agenticScore >= 0.6;
  const isExplicitAgentic = config.overrides.agenticMode ?? false;
  const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
  const tierConfigs = useAgenticTiers ? config.agenticTiers! : config.tiers;

  // --- Override: large context → force COMPLEX ---
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${useAgenticTiers ? " | agentic" : ""}`,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
    );
  }

  // Structured output detection
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;

  let tier: Tier;
  let confidence: number;
  const method: "rules" | "llm" = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    // Ambiguous — default to configurable tier (no external API call)
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }

  // Apply structured output minimum tier
  if (hasStructuredOutput) {
    const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }

  // Add agentic mode indicator to reasoning
  if (isAutoAgentic) {
    reasoning += " | auto-agentic";
  } else if (isExplicitAgentic) {
    reasoning += " | agentic";
  }

  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
  );
}

export { getFallbackChain, getFallbackChainFiltered } from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./types.js";
export type { ModelPricing } from "./selector.js";
