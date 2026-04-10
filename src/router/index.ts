/**
 * Smart Router Entry Point
 *
 * Classifies requests and routes to the cheapest capable model.
 * Delegates to pluggable RouterStrategy (default: RulesStrategy, <1ms).
 */

import type { RoutingDecision, RouterOptions } from "./types.js";
import { getStrategy } from "./strategy.js";

/**
 * Route a request to the cheapest capable model.
 * Delegates to the registered "rules" strategy by default.
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const strategy = getStrategy("rules");
  return strategy.route(prompt, systemPrompt, maxOutputTokens, options);
}

export { getStrategy, registerStrategy } from "./strategy.js";
export {
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
  calculateModelCost,
} from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type {
  RoutingDecision,
  Tier,
  TierConfig,
  RoutingConfig,
  RouterOptions,
  RouterStrategy,
} from "./types.js";
export type { ModelPricing } from "./selector.js";
