/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * Delegates to pluggable RouterStrategy (default: RulesStrategy, <1ms).
 */

import type { RoutingDecision, RouterOptions } from "./types.js";
import { getStrategy, registerStrategy } from "./strategy.js";
import { PortfolioStrategy } from "./portfolio.js";

// Register here instead of strategy.ts so PortfolioStrategy can reuse the
// stable RulesStrategy without introducing a module cycle.
registerStrategy(new PortfolioStrategy());

/**
 * Route a request to the cheapest capable model.
 * Delegates to the configured strategy (PortfolioStrategy by default).
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const strategy = getStrategy(options.config.strategy ?? "portfolio");
  return strategy.route(prompt, systemPrompt, maxOutputTokens, options);
}

export { getStrategy, registerStrategy } from "./strategy.js";
export { inferToolRequirement } from "./tool-intent.js";
export {
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
  filterCandidatesByCapacity,
  calculateModelCost,
} from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type {
  RoutingDecision,
  Tier,
  TaskType,
  RoutingConfig,
  RouterOptions,
  RouterStrategy,
} from "./types.js";
export type { ModelPricing } from "./selector.js";
