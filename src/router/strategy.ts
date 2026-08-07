/**
 * Router Strategy Registry
 *
 * Pluggable strategy system for request routing.
 * Default: RulesStrategy — identical to the original inline route() logic, <1ms.
 */

import type {
  Tier,
  TierConfig,
  Promotion,
  RoutingDecision,
  RouterStrategy,
  RouterOptions,
} from "./types.js";
import { classifyByRules } from "./rules.js";
import { selectModel } from "./selector.js";

/**
 * Apply active time-windowed promotions to tier configs.
 * Returns a new tierConfigs object with promotion overrides merged in.
 * Expired or not-yet-active promotions are ignored.
 */
function applyPromotions(
  tierConfigs: Record<Tier, TierConfig>,
  promotions: Promotion[] | undefined,
  profile: "auto" | "eco" | "premium" | "agentic",
  now: Date = new Date(),
): Record<Tier, TierConfig> {
  if (!promotions || promotions.length === 0) return tierConfigs;

  let result = tierConfigs;
  for (const promo of promotions) {
    // Check time window
    const start = new Date(promo.startDate);
    const end = new Date(promo.endDate);
    if (now < start || now >= end) continue;

    // Check profile filter
    if (promo.profiles && !promo.profiles.includes(profile)) continue;

    // Shallow-clone on first mutation
    if (result === tierConfigs) {
      result = { ...tierConfigs };
      for (const t of Object.keys(result) as Tier[]) {
        result[t] = { ...result[t] };
      }
    }

    // Merge overrides
    for (const [tier, override] of Object.entries(promo.tierOverrides) as [
      Tier,
      Partial<TierConfig>,
    ][]) {
      if (!result[tier]) continue;
      if (override.primary) result[tier].primary = override.primary;
      if (override.fallback) result[tier].fallback = override.fallback;
    }
  }

  return result;
}

/**
 * Rules-based routing strategy.
 * Extracted from the original route() in index.ts — logic is identical.
 * Attaches tierConfigs and profile to the decision for downstream use.
 */
export class RulesStrategy implements RouterStrategy {
  readonly name = "rules";

  route(
    prompt: string,
    systemPrompt: string | undefined,
    maxOutputTokens: number,
    options: RouterOptions,
  ): RoutingDecision {
    const { config, modelPricing } = options;

    // Estimate input tokens (~4 chars per token)
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const scanLimit = Math.max(1, Math.min(8_000, config.classifier.promptTruncationChars));
    const sample = (value: string): string => {
      if (value.length <= scanLimit) return value;
      const prefixLength = Math.ceil(scanLimit / 2);
      return `${value.slice(0, prefixLength)}\n${value.slice(-(scanLimit - prefixLength))}`;
    };
    const scannedPrompt = sample(prompt);
    const scannedSystemPrompt = systemPrompt ? sample(systemPrompt) : undefined;

    // --- Rule-based classification (runs first to get agenticScore) ---
    const ruleResult = classifyByRules(
      scannedPrompt,
      scannedSystemPrompt,
      estimatedTokens,
      config.scoring,
    );

    // --- Select tier configs based on routing profile ---
    const { routingProfile } = options;
    let tierConfigs: Record<Tier, { primary: string; fallback: string[] }>;
    let profileSuffix: string;
    let profile: RoutingDecision["profile"];

    if (routingProfile === "eco") {
      // `ecoTiers: null` explicitly disables the special eco tier set while
      // keeping eco routing semantics. Fall back to regular tiers instead of
      // dropping into auto routing (which could select agentic tiers).
      tierConfigs = config.ecoTiers ?? config.tiers;
      profileSuffix = config.ecoTiers ? " | eco" : " | eco (default tiers)";
      profile = "eco";
    } else if (routingProfile === "premium") {
      // `premiumTiers: null` disables the premium-specific tier set but the
      // request is still a premium-profile request, so use regular tiers while
      // preserving premium metadata/cost semantics.
      tierConfigs = config.premiumTiers ?? config.tiers;
      profileSuffix = config.premiumTiers ? " | premium" : " | premium (default tiers)";
      profile = "premium";
    } else {
      // Auto profile (or undefined): intelligent routing with agentic detection.
      //
      // `agenticMode` semantics:
      //   - `true`  → force agentic tiers (ignore heuristics)
      //   - `false` → disable agentic tiers entirely (even if tools are present)
      //   - `undefined` → auto-detect via heuristics (tools present OR high agenticScore)
      const agenticScore = ruleResult.agenticScore ?? 0;
      const isAutoAgentic = agenticScore >= 0.5;
      const agenticModeSetting = config.overrides.agenticMode;
      const hasToolsInRequest = options.requiresTools ?? options.hasTools ?? false;
      let useAgenticTiers: boolean;
      if (agenticModeSetting === false) {
        // Explicitly disabled — never use agentic tiers
        useAgenticTiers = false;
      } else if (agenticModeSetting === true) {
        // Explicitly enabled — use agentic tiers if available
        useAgenticTiers = config.agenticTiers != null;
      } else {
        // Auto-detect
        useAgenticTiers = (hasToolsInRequest || isAutoAgentic) && config.agenticTiers != null;
      }
      tierConfigs = useAgenticTiers ? config.agenticTiers! : config.tiers;
      profileSuffix = useAgenticTiers ? ` | agentic${hasToolsInRequest ? " (tools)" : ""}` : "";
      profile = useAgenticTiers ? "agentic" : "auto";
    }

    // Apply time-windowed promotions
    tierConfigs = applyPromotions(tierConfigs, config.promotions, profile!, options.now);

    const agenticScoreValue = ruleResult.agenticScore;

    // --- Override: large context → force COMPLEX ---
    if (estimatedTokens > config.overrides.maxTokensForceComplex) {
      const decision = selectModel(
        "COMPLEX",
        0.95,
        "rules",
        `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
        tierConfigs,
        modelPricing,
        estimatedTokens,
        maxOutputTokens,
        routingProfile,
        agenticScoreValue,
      );
      return { ...decision, tierConfigs, profile };
    }

    // Structured output detection
    const hasStructuredOutput =
      options.requiresStructuredOutput === true ||
      (scannedSystemPrompt ? /json|structured|schema/i.test(scannedSystemPrompt) : false);

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

    // Add routing profile suffix to reasoning
    reasoning += profileSuffix;

    const decision = selectModel(
      tier,
      confidence,
      method,
      reasoning,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
      routingProfile,
      agenticScoreValue,
    );
    return { ...decision, tierConfigs, profile };
  }
}

// --- Strategy Registry ---

const registry = new Map<string, RouterStrategy>();
registry.set("rules", new RulesStrategy());

export function getStrategy(name: string): RouterStrategy {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`Unknown routing strategy: ${name}`);
  }
  return strategy;
}

export function registerStrategy(strategy: RouterStrategy): void {
  registry.set(strategy.name, strategy);
}
