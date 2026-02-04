/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * Uses hybrid approach: rules first (< 1ms), LLM fallback for ambiguous cases.
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types.js";
import { classifyByRules } from "./rules.js";
import { classifyByLLM } from "./llm-classifier.js";
import { selectModel, getFallbackChain, type ModelPricing } from "./selector.js";

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing: Map<string, ModelPricing>;
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  apiBase: string;
};

/**
 * Route a request to the cheapest capable model.
 *
 * 1. Check overrides (large context, structured output)
 * 2. Run rule-based classifier
 * 3. If ambiguous, run LLM classifier
 * 4. Select model for tier
 * 5. Return RoutingDecision with metadata
 */
export async function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): Promise<RoutingDecision> {
  const { config, modelPricing, payFetch, apiBase } = options;

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);

  // --- Override: large context → force COMPLEX ---
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens`,
      config.tiers,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
    );
  }

  // Structured output detection
  const hasStructuredOutput = systemPrompt
    ? /json|structured|schema/i.test(systemPrompt)
    : false;

  // --- Rule-based classification ---
  const ruleResult = classifyByRules(
    prompt,
    systemPrompt,
    estimatedTokens,
    config.scoring,
  );

  let tier: Tier;
  let confidence: number;
  let method: "rules" | "llm" = "rules";
  let reasoning = `score=${ruleResult.score} | ${ruleResult.signals.join(", ")}`;

  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    // Ambiguous — LLM classifier fallback
    const llmResult = await classifyByLLM(
      prompt,
      {
        model: config.classifier.llmModel,
        maxTokens: config.classifier.llmMaxTokens,
        temperature: config.classifier.llmTemperature,
        truncationChars: config.classifier.promptTruncationChars,
        cacheTtlMs: config.classifier.cacheTtlMs,
      },
      payFetch,
      apiBase,
    );

    tier = llmResult.tier;
    confidence = llmResult.confidence;
    method = "llm";
    reasoning += ` | ambiguous -> LLM: ${tier}`;
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

  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    config.tiers,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
  );
}

export { getFallbackChain } from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./types.js";
export type { ModelPricing } from "./selector.js";
