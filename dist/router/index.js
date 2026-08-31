import { createRequire as __blockrun_createRequire } from 'node:module'; const require = __blockrun_createRequire(import.meta.url);

// ../../../../../../../Users/vickyfu/Documents/blockrun-web/ClawRouter/node_modules/@blockrun/router-core/dist/index.js
function scoreTokenCount(estimatedTokens, thresholds) {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}
function scoreKeywordMatch(text, keywords, name, signalLabel, thresholds, scores) {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  return { name, score: scores.none, signal: null };
}
function scoreMultiStep(text) {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}
function scoreQuestionComplexity(prompt) {
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}
function scoreAgenticTask(text, keywords) {
  let matchCount = 0;
  const signals = [];
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) {
        signals.push(keyword);
      }
    }
  }
  if (matchCount >= 4) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 1,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 1
    };
  } else if (matchCount >= 3) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.6,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 0.6
    };
  } else if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`
      },
      agenticScore: 0.2
    };
  }
  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0
  };
}
function classifyByRules(prompt, systemPrompt, estimatedTokens, config) {
  const userText = prompt.toLowerCase();
  const dimensions = [
    // Token count uses total estimated tokens (system + user) — context size matters for model selection
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(
      userText,
      config.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      userText,
      config.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1, high: -1 }
    ),
    scoreMultiStep(userText),
    scoreQuestionComplexity(prompt),
    // 6 new dimensions
    scoreKeywordMatch(
      userText,
      config.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 }
    ),
    scoreKeywordMatch(
      userText,
      config.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      userText,
      config.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 }
    )
  ];
  const agenticResult = scoreAgenticTask(userText, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }
  const reasoningMatches = config.reasoningKeywords.filter(
    (kw) => userText.includes(kw.toLowerCase())
  );
  if (reasoningMatches.length >= 2) {
    const confidence2 = calibrateConfidence(
      Math.max(weightedScore, 0.3),
      // ensure positive for confidence calc
      config.confidenceSteepness
    );
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence2, 0.85),
      signals,
      agenticScore,
      dimensions
    };
  }
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier;
  let distanceFromBoundary;
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore, dimensions };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore, dimensions };
}
function calibrateConfidence(distance, steepness) {
  return 1 / (1 + Math.exp(-steepness * distance));
}
var BASELINE_MODEL_ID = "anthropic/claude-opus-4.7";
var BASELINE_INPUT_PRICE = 5;
var BASELINE_OUTPUT_PRICE = 25;
function selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile, agenticScore) {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);
  let costEstimate;
  if (pricing?.flatPrice !== void 0) {
    costEstimate = pricing.flatPrice;
  } else {
    const inputPrice = pricing?.inputPrice ?? 0;
    const outputPrice = pricing?.outputPrice ?? 0;
    costEstimate = estimatedInputTokens / 1e6 * inputPrice + maxOutputTokens / 1e6 * outputPrice;
  }
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings,
    ...agenticScore !== void 0 && { agenticScore }
  };
}
function getFallbackChain(tier, tierConfigs) {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}
var SERVER_MARGIN_PERCENT = 5;
var MIN_PAYMENT_USD = 1e-3;
function calculateModelCost(model, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile) {
  const pricing = modelPricing.get(model);
  let costEstimate;
  if (pricing?.flatPrice !== void 0) {
    costEstimate = Math.max(pricing.flatPrice * (1 + SERVER_MARGIN_PERCENT / 100), MIN_PAYMENT_USD);
  } else {
    const inputPrice = pricing?.inputPrice ?? 0;
    const outputPrice = pricing?.outputPrice ?? 0;
    const inputCost = estimatedInputTokens / 1e6 * inputPrice;
    const outputCost = maxOutputTokens / 1e6 * outputPrice;
    costEstimate = Math.max(
      (inputCost + outputCost) * (1 + SERVER_MARGIN_PERCENT / 100),
      MIN_PAYMENT_USD
    );
  }
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? BASELINE_INPUT_PRICE;
  const opusOutputPrice = opusPricing?.outputPrice ?? BASELINE_OUTPUT_PRICE;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return { costEstimate, baselineCost, savings };
}
function filterByToolCalling(models, hasTools, supportsToolCalling) {
  if (!hasTools) return models;
  const filtered = models.filter(supportsToolCalling);
  return filtered.length > 0 ? filtered : models;
}
function filterByVision(models, hasVision, supportsVision) {
  if (!hasVision) return models;
  const filtered = models.filter(supportsVision);
  return filtered.length > 0 ? filtered : models;
}
function filterByExcludeList(models, excludeList) {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((m) => !excludeList.has(m));
  return filtered.length > 0 ? filtered : models;
}
function getFallbackChainFiltered(tier, tierConfigs, estimatedTotalTokens, getContextWindow) {
  const fullChain = getFallbackChain(tier, tierConfigs);
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === void 0) {
      return true;
    }
    return contextWindow >= estimatedTotalTokens * 1.1;
  });
  if (filtered.length === 0) {
    return fullChain;
  }
  return filtered;
}
function filterCandidatesByCapacity(models, estimatedInputTokens, requestedOutputTokens, getCapabilities) {
  const filtered = models.filter((modelId) => {
    const capabilities = getCapabilities(modelId);
    if (!capabilities) return true;
    return capabilities.contextWindow >= (estimatedInputTokens + requestedOutputTokens) * 1.1 && capabilities.maxOutput >= requestedOutputTokens;
  });
  return filtered;
}
function applyPromotions(tierConfigs, promotions, profile, now = /* @__PURE__ */ new Date()) {
  if (!promotions || promotions.length === 0) return tierConfigs;
  let result = tierConfigs;
  for (const promo of promotions) {
    const start = new Date(promo.startDate);
    const end = new Date(promo.endDate);
    if (now < start || now >= end) continue;
    if (promo.profiles && !promo.profiles.includes(profile)) continue;
    if (result === tierConfigs) {
      result = { ...tierConfigs };
      for (const t of Object.keys(result)) {
        result[t] = { ...result[t] };
      }
    }
    for (const [tier, override] of Object.entries(promo.tierOverrides)) {
      if (!result[tier]) continue;
      if (override.primary) result[tier].primary = override.primary;
      if (override.fallback) result[tier].fallback = override.fallback;
    }
  }
  return result;
}
function applyUnavailableModels(tierConfigs, unavailableModels) {
  if (!unavailableModels || unavailableModels.length === 0) return tierConfigs;
  const dead = new Set(unavailableModels);
  let result = tierConfigs;
  for (const tier of Object.keys(tierConfigs)) {
    const config = tierConfigs[tier];
    const alive = [config.primary, ...config.fallback].filter((model) => !dead.has(model));
    if (alive.length === 0 || alive[0] === config.primary && alive.length === config.fallback.length + 1) {
      continue;
    }
    if (result === tierConfigs) result = { ...tierConfigs };
    result[tier] = { primary: alive[0], fallback: alive.slice(1) };
  }
  return result;
}
var RulesStrategy = class {
  name = "rules";
  route(prompt, systemPrompt, maxOutputTokens, options) {
    const { config, modelPricing } = options;
    const fullText = `${systemPrompt ?? ""} ${prompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);
    const scanLimit = Math.max(1, Math.min(8e3, config.classifier.promptTruncationChars));
    const sample = (value) => {
      if (value.length <= scanLimit) return value;
      const prefixLength = Math.ceil(scanLimit / 2);
      return `${value.slice(0, prefixLength)}
${value.slice(-(scanLimit - prefixLength))}`;
    };
    const scannedPrompt = sample(prompt);
    const scannedSystemPrompt = systemPrompt ? sample(systemPrompt) : void 0;
    const ruleResult = classifyByRules(
      scannedPrompt,
      scannedSystemPrompt,
      estimatedTokens,
      config.scoring
    );
    const { routingProfile } = options;
    let tierConfigs;
    let profileSuffix;
    let profile;
    if (routingProfile === "eco") {
      tierConfigs = config.ecoTiers ?? config.tiers;
      profileSuffix = config.ecoTiers ? " | eco" : " | eco (default tiers)";
      profile = "eco";
    } else if (routingProfile === "premium") {
      tierConfigs = config.premiumTiers ?? config.tiers;
      profileSuffix = config.premiumTiers ? " | premium" : " | premium (default tiers)";
      profile = "premium";
    } else {
      const agenticScore = ruleResult.agenticScore ?? 0;
      const isAutoAgentic = agenticScore >= 0.5;
      const agenticModeSetting = config.overrides.agenticMode;
      const hasToolsInRequest = options.requiresTools ?? options.hasTools ?? false;
      let useAgenticTiers;
      if (agenticModeSetting === false) {
        useAgenticTiers = false;
      } else if (agenticModeSetting === true) {
        useAgenticTiers = config.agenticTiers != null;
      } else {
        useAgenticTiers = (hasToolsInRequest || isAutoAgentic) && config.agenticTiers != null;
      }
      tierConfigs = useAgenticTiers ? config.agenticTiers : config.tiers;
      profileSuffix = useAgenticTiers ? ` | agentic${hasToolsInRequest ? " (tools)" : ""}` : "";
      profile = useAgenticTiers ? "agentic" : "auto";
    }
    tierConfigs = applyPromotions(tierConfigs, config.promotions, profile, options.now);
    tierConfigs = applyUnavailableModels(tierConfigs, options.unavailableModels);
    const agenticScoreValue = ruleResult.agenticScore;
    if (estimatedTokens > config.overrides.maxTokensForceComplex) {
      const decision2 = selectModel(
        "COMPLEX",
        0.95,
        "rules",
        `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
        tierConfigs,
        modelPricing,
        estimatedTokens,
        maxOutputTokens,
        routingProfile,
        agenticScoreValue
      );
      return { ...decision2, tierConfigs, profile };
    }
    const hasStructuredOutput = options.requiresStructuredOutput === true || (scannedSystemPrompt ? /json|structured|schema/i.test(scannedSystemPrompt) : false);
    let tier;
    let confidence;
    const method = "rules";
    let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;
    if (ruleResult.tier !== null) {
      tier = ruleResult.tier;
      confidence = ruleResult.confidence;
    } else {
      tier = config.overrides.ambiguousDefaultTier;
      confidence = 0.5;
      reasoning += ` | ambiguous -> default: ${tier}`;
    }
    if (hasStructuredOutput) {
      const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
      const minTier = config.overrides.structuredOutputMinTier;
      if (tierRank[tier] < tierRank[minTier]) {
        reasoning += ` | upgraded to ${minTier} (structured output)`;
        tier = minTier;
      }
    }
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
      agenticScoreValue
    );
    return { ...decision, tierConfigs, profile };
  }
};
var registry = /* @__PURE__ */ new Map();
registry.set("rules", new RulesStrategy());
function getStrategy(name) {
  const strategy = registry.get(name);
  if (!strategy) {
    throw new Error(`Unknown routing strategy: ${name}`);
  }
  return strategy;
}
function registerStrategy(strategy) {
  registry.set(strategy.name, strategy);
}
var DEFAULT_MODEL_CAPABILITIES = Object.freeze({
  "anthropic/claude-fable-5": {
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-haiku-4.5": {
    // override: The public catalog's `categories` omit "vision" for this Anthropic model even though the gateway accepts image input for it (the prior hand-maintained snapshot had it, and Anthropic's model card lists it). Without this the vision filter would silently drop it — reported against the catalog; remove once the categories carry vision.
    contextWindow: 2e5,
    maxOutputTokens: 64e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-opus-4.5": {
    contextWindow: 2e5,
    maxOutputTokens: 64e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-opus-4.7": {
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-opus-4.8": {
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-opus-5": {
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-sonnet-4.5": {
    contextWindow: 2e5,
    maxOutputTokens: 64e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-sonnet-4.6": {
    // override: The public catalog's `categories` omit "vision" for this Anthropic model even though the gateway accepts image input for it (the prior hand-maintained snapshot had it, and Anthropic's model card lists it). Without this the vision filter would silently drop it — reported against the catalog; remove once the categories carry vision.
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "anthropic/claude-sonnet-5": {
    contextWindow: 1e6,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "cohere/north-mini-code": {
    // supportsTools: not probed — fails closed
    contextWindow: 256e3,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: false
  },
  "deepseek/deepseek-chat": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "deepseek/deepseek-reasoner": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "deepseek/deepseek-v4-pro": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "google/gemini-2.5-flash": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "google/gemini-2.5-flash-lite": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "google/gemini-2.5-pro": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "google/gemini-3-flash-preview": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "google/gemini-3.1-flash-lite": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "google/gemini-3.1-pro": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "google/gemini-3.5-flash": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "google/gemini-3.5-flash-lite": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "google/gemini-3.6-flash": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "minimax/minimax-m2.7": {
    contextWindow: 204800,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: false
  },
  "minimax/minimax-m3": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "moonshot/kimi-k3": {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: true
  },
  "nvidia/llama-3.2-11b-vision": {
    // supportsTools: not probed — fails closed
    contextWindow: 128e3,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: true
  },
  "nvidia/nemotron-3-nano-30b": {
    // supportsTools: not probed — fails closed
    contextWindow: 131072,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: false
  },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
    contextWindow: 256e3,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: true
  },
  "nvidia/nemotron-3-ultra-550b": {
    // supportsTools: not probed — fails closed
    contextWindow: 1e6,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: false
  },
  "nvidia/nemotron-3.5-lightning": {
    // supportsTools: not probed — fails closed
    contextWindow: 1e6,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: false
  },
  "openai/chat-latest": {
    contextWindow: 128e3,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-4.1": {
    contextWindow: 128e3,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-4.1-mini": {
    contextWindow: 128e3,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-4.1-nano": {
    contextWindow: 128e3,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-4o": {
    contextWindow: 128e3,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-4o-mini": {
    contextWindow: 128e3,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-5-mini": {
    contextWindow: 2e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-5.2": {
    contextWindow: 4e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.2-pro": {
    // supportsTools: not probed — fails closed
    contextWindow: 4e5,
    maxOutputTokens: 128e3,
    supportsTools: false,
    supportsVision: true
  },
  "openai/gpt-5.3-codex": {
    // supportsTools: gateway unavailable at probe time — fails closed; override: 2026-08-29 probe: every request (6 plain + 3 tool attempts) returned a gateway 500, so the probe measured an incident, not the model. Codex's function calling is established by the 2026-07 Terminal-Bench / tau2 calibration trajectories in portfolio.ts. Hosts observing the 500s should drop it with RouterOptions.unavailableModels rather than this snapshot claiming the model cannot call tools.
    contextWindow: 4e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-5.4": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.4-mini": {
    contextWindow: 4e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.4-nano": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "openai/gpt-5.4-pro": {
    // supportsTools: not probed — fails closed
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: false,
    supportsVision: true
  },
  "openai/gpt-5.5": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.5-pro": {
    // supportsTools: not probed — fails closed
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: false,
    supportsVision: true
  },
  "openai/gpt-5.6-luna": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.6-luna-pro": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: false,
    supportsVision: true
  },
  "openai/gpt-5.6-sol": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.6-sol-pro": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.6-terra": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/gpt-5.6-terra-pro": {
    contextWindow: 105e4,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: true
  },
  "openai/o1": {
    contextWindow: 2e5,
    maxOutputTokens: 1e5,
    supportsTools: true,
    supportsVision: false
  },
  "openai/o3": {
    contextWindow: 2e5,
    maxOutputTokens: 1e5,
    supportsTools: true,
    supportsVision: false
  },
  "openai/o3-mini": {
    contextWindow: 128e3,
    maxOutputTokens: 1e5,
    supportsTools: true,
    supportsVision: false
  },
  "openai/o4-mini": {
    contextWindow: 128e3,
    maxOutputTokens: 1e5,
    supportsTools: true,
    supportsVision: false
  },
  "poolside/laguna-xs-2.1": {
    // supportsTools: not probed — fails closed
    contextWindow: 131072,
    maxOutputTokens: 16384,
    supportsTools: false,
    supportsVision: false
  },
  "qwen/qwen3.7-flash": {
    contextWindow: 1e6,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "qwen/qwen3.7-max": {
    contextWindow: 1e6,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsVision: false
  },
  "qwen/qwen3.7-plus": {
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false
  },
  "tencent/hy3": {
    contextWindow: 262144,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "xai/grok-4.3": {
    contextWindow: 1e6,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true
  },
  "xai/grok-4.5": {
    contextWindow: 5e5,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true
  },
  "xai/grok-build-0.1": {
    contextWindow: 256e3,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: false
  },
  "xiaomi/mimo-v2.5-pro": {
    contextWindow: 1048576,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5": {
    contextWindow: 2e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5-turbo": {
    contextWindow: 2e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5.1": {
    contextWindow: 2e5,
    maxOutputTokens: 128e3,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5.2": {
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5.3": {
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: false
  },
  "zai/glm-5.3-flash": {
    contextWindow: 1e6,
    maxOutputTokens: 131072,
    supportsTools: true,
    supportsVision: true
  }
});
var model_profiles_generated_default = {
  "anthropic/claude-fable-5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 9298.5,
    p95LatencyMs: 9873.4,
    outputTokensPerSecond: 55.17,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-haiku-4.5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3157.4,
    p95LatencyMs: 3170.7,
    outputTokensPerSecond: 162.16,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-opus-4.5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6497.7,
    p95LatencyMs: 6953.7,
    outputTokensPerSecond: 78.99,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-opus-4.7": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5316.5,
    p95LatencyMs: 6121.5,
    outputTokensPerSecond: 97.34,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-opus-4.8": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6216.1,
    p95LatencyMs: 6847.7,
    outputTokensPerSecond: 82.81,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-opus-5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 7309,
    p95LatencyMs: 7745.2,
    outputTokensPerSecond: 70.17,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-sonnet-4.5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6330.4,
    p95LatencyMs: 6631.6,
    outputTokensPerSecond: 81.03,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-sonnet-4.6": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6508,
    p95LatencyMs: 6698.3,
    outputTokensPerSecond: 78.6,
    errorRate: 0,
    samples: 3
  },
  "anthropic/claude-sonnet-5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6165.4,
    p95LatencyMs: 6582.9,
    outputTokensPerSecond: 83.62,
    errorRate: 0,
    samples: 3
  },
  "deepseek/deepseek-chat": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4351.4,
    p95LatencyMs: 4543.7,
    outputTokensPerSecond: 117.78,
    errorRate: 0,
    samples: 3
  },
  "deepseek/deepseek-reasoner": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5201.2,
    p95LatencyMs: 6079.6,
    outputTokensPerSecond: 99.77,
    errorRate: 0,
    samples: 3
  },
  "deepseek/deepseek-v4-pro": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 8781.2,
    p95LatencyMs: 9881.1,
    outputTokensPerSecond: 58.98,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-2.5-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5416.4,
    p95LatencyMs: 6442.8,
    outputTokensPerSecond: 213.07,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-2.5-flash-lite": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5002.6,
    p95LatencyMs: 5780.3,
    outputTokensPerSecond: 408.43,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-2.5-pro": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 28169.5,
    p95LatencyMs: 29491.4,
    outputTokensPerSecond: 147.3,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3-flash-preview": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4717.1,
    p95LatencyMs: 5037.1,
    outputTokensPerSecond: 198.71,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3.1-flash-lite": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 2855.8,
    p95LatencyMs: 3172.7,
    outputTokensPerSecond: 286.91,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3.1-pro": {
    measuredAt: "2026-08-29T16:59:54Z",
    latencyMs: 24194.1,
    p95LatencyMs: 27269.6,
    outputTokensPerSecond: 109.47,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3.5-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5320.6,
    p95LatencyMs: 5429.8,
    outputTokensPerSecond: 226.21,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3.5-flash-lite": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3515.8,
    p95LatencyMs: 4363.4,
    outputTokensPerSecond: 248.9,
    errorRate: 0,
    samples: 3
  },
  "google/gemini-3.6-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 13020,
    p95LatencyMs: 15383.1,
    outputTokensPerSecond: 187.87,
    errorRate: 0,
    samples: 3
  },
  "minimax/minimax-m2.7": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 8761.1,
    p95LatencyMs: 10199.3,
    outputTokensPerSecond: 59.18,
    errorRate: 0,
    samples: 3
  },
  "minimax/minimax-m3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 11101.9,
    p95LatencyMs: 26087.1,
    outputTokensPerSecond: 101.12,
    errorRate: 0,
    samples: 3
  },
  "moonshot/kimi-k3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 24498.9,
    p95LatencyMs: 40365.3,
    outputTokensPerSecond: 25.11,
    errorRate: 0,
    samples: 3
  },
  "nvidia/mistral-nemotron": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 7349.6,
    p95LatencyMs: 9932.3,
    outputTokensPerSecond: 79.48,
    errorRate: 0.3333,
    samples: 3
  },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
    measuredAt: "2026-08-29T16:59:54Z",
    latencyMs: 9324.6,
    p95LatencyMs: 12992,
    outputTokensPerSecond: 64.96,
    errorRate: 0.3333,
    samples: 3
  },
  "nvidia/nemotron-nano-12b-v2-vl": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5846.9,
    p95LatencyMs: 5846.9,
    outputTokensPerSecond: 87.57,
    errorRate: 0.6667,
    samples: 3
  },
  "nvidia/nemotron-nano-9b-v2": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5282.5,
    p95LatencyMs: 5282.5,
    outputTokensPerSecond: 96.92,
    errorRate: 0.6667,
    samples: 3
  },
  "nvidia/step-3.7-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4617.4,
    p95LatencyMs: 5237.4,
    outputTokensPerSecond: 112.92,
    errorRate: 0.3333,
    samples: 3
  },
  "openai/chat-latest": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3690.9,
    p95LatencyMs: 4344,
    outputTokensPerSecond: 111.85,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-4.1": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3527.9,
    p95LatencyMs: 3831.7,
    outputTokensPerSecond: 141.27,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-4.1-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4268.2,
    p95LatencyMs: 5101.5,
    outputTokensPerSecond: 103.42,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-4.1-nano": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3088.3,
    p95LatencyMs: 3369.2,
    outputTokensPerSecond: 150.31,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-4o": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 2995.2,
    p95LatencyMs: 3174.2,
    outputTokensPerSecond: 171.32,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-4o-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4751.5,
    p95LatencyMs: 4930.4,
    outputTokensPerSecond: 107.84,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4558.1,
    p95LatencyMs: 5081.9,
    outputTokensPerSecond: 113.25,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.2": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5436.6,
    p95LatencyMs: 5928.8,
    outputTokensPerSecond: 95.47,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.3-codex": {
    measuredAt: "2026-08-29T16:59:54Z",
    latencyMs: 15290.4,
    p95LatencyMs: 15290.4,
    outputTokensPerSecond: 33.49,
    errorRate: 0.6667,
    samples: 3
  },
  "openai/gpt-5.4": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5596,
    p95LatencyMs: 5919.4,
    outputTokensPerSecond: 91.67,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.4-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3377.8,
    p95LatencyMs: 3646.8,
    outputTokensPerSecond: 138.08,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.4-nano": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4040.4,
    p95LatencyMs: 4205.9,
    outputTokensPerSecond: 118.52,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6367.8,
    p95LatencyMs: 7330.7,
    outputTokensPerSecond: 81.29,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.6-luna": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6064.5,
    p95LatencyMs: 7347.3,
    outputTokensPerSecond: 87.93,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.6-luna-pro": {
    measuredAt: "2026-08-29T16:59:54Z",
    latencyMs: 13914.9,
    p95LatencyMs: 13914.9,
    outputTokensPerSecond: 36.79,
    errorRate: 0.6667,
    samples: 3
  },
  "openai/gpt-5.6-sol": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 7720.2,
    p95LatencyMs: 9108.2,
    outputTokensPerSecond: 67.47,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.6-sol-pro": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 11442.7,
    p95LatencyMs: 13363.1,
    outputTokensPerSecond: 148.75,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.6-terra": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4941,
    p95LatencyMs: 5095.3,
    outputTokensPerSecond: 103.69,
    errorRate: 0,
    samples: 3
  },
  "openai/gpt-5.6-terra-pro": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3574.1,
    p95LatencyMs: 4126.3,
    outputTokensPerSecond: 133.59,
    errorRate: 0,
    samples: 3
  },
  "openai/o1": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4324.9,
    p95LatencyMs: 5838.1,
    outputTokensPerSecond: 125.86,
    errorRate: 0,
    samples: 3
  },
  "openai/o3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 5463.4,
    p95LatencyMs: 5613.1,
    outputTokensPerSecond: 93.8,
    errorRate: 0,
    samples: 3
  },
  "openai/o3-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 2912.7,
    p95LatencyMs: 3092.1,
    outputTokensPerSecond: 176.49,
    errorRate: 0,
    samples: 3
  },
  "openai/o4-mini": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 4958.7,
    p95LatencyMs: 5313,
    outputTokensPerSecond: 103.81,
    errorRate: 0,
    samples: 3
  },
  "qwen/qwen3.7-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 3385.5,
    p95LatencyMs: 4042.7,
    outputTokensPerSecond: 153.94,
    errorRate: 0,
    samples: 3
  },
  "qwen/qwen3.7-max": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 9387.1,
    p95LatencyMs: 10490.2,
    outputTokensPerSecond: 54.92,
    errorRate: 0,
    samples: 3
  },
  "qwen/qwen3.7-plus": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 9766.6,
    p95LatencyMs: 9798.2,
    outputTokensPerSecond: 52.42,
    errorRate: 0,
    samples: 3
  },
  "tencent/hy3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6062.3,
    p95LatencyMs: 7070.2,
    outputTokensPerSecond: 87.3,
    errorRate: 0,
    samples: 3
  },
  "xai/grok-4.3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 9467.7,
    p95LatencyMs: 10087.9,
    outputTokensPerSecond: 48.36,
    errorRate: 0,
    samples: 3
  },
  "xai/grok-4.5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 13564.8,
    p95LatencyMs: 17351.9,
    outputTokensPerSecond: 60.71,
    errorRate: 0,
    samples: 3
  },
  "xai/grok-build-0.1": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 16394.8,
    p95LatencyMs: 18035.4,
    outputTokensPerSecond: 96.86,
    errorRate: 0,
    samples: 3
  },
  "xiaomi/mimo-v2.5-pro": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 12070.7,
    p95LatencyMs: 12386.8,
    outputTokensPerSecond: 42.44,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 6839.7,
    p95LatencyMs: 7261.4,
    outputTokensPerSecond: 75.16,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5-turbo": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 55348.5,
    p95LatencyMs: 114086.6,
    outputTokensPerSecond: 14.64,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5.1": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 15658.4,
    p95LatencyMs: 17307.1,
    outputTokensPerSecond: 32.9,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5.2": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 10308.5,
    p95LatencyMs: 15127.6,
    outputTokensPerSecond: 54.87,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5.3": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 7272.4,
    p95LatencyMs: 7998.1,
    outputTokensPerSecond: 71.09,
    errorRate: 0,
    samples: 3
  },
  "zai/glm-5.3-flash": {
    measuredAt: "2026-08-29T16:51:33Z",
    latencyMs: 10545.3,
    p95LatencyMs: 11672.4,
    outputTokensPerSecond: 49.01,
    errorRate: 0,
    samples: 3
  }
};
var LIVE_MODEL_PROFILES = Object.freeze(
  model_profiles_generated_default
);
var HISTORICAL_MODEL_PROFILES = Object.freeze({
  "anthropic/claude-haiku-4.5": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 2305,
    outputTokensPerSecond: 140.6
  },
  "anthropic/claude-sonnet-4.6": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 2110,
    outputTokensPerSecond: 121.3
  },
  "deepseek/deepseek-chat": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 1431,
    outputTokensPerSecond: 179.2,
    intelligenceIndex: 32
  },
  "google/gemini-2.5-flash": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 1238,
    outputTokensPerSecond: 207.6,
    intelligenceIndex: 20
  },
  "google/gemini-2.5-flash-lite": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 1353,
    outputTokensPerSecond: 192.5,
    intelligenceIndex: 20
  },
  "google/gemini-2.5-pro": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 1294,
    outputTokensPerSecond: 197.8
  },
  "google/gemini-3.1-pro": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 1609,
    outputTokensPerSecond: 167.2
  },
  "openai/gpt-4o-mini": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 2764,
    outputTokensPerSecond: 92.8
  },
  "openai/gpt-5.3-codex": {
    measuredAt: "2026-03-16T13:50:48Z",
    latencyMs: 7935,
    outputTokensPerSecond: 32.3
  }
});
function inferToolRequirement(prompt, _systemPrompt, toolChoice) {
  if (toolChoice === "none") return false;
  if (toolChoice === "required") return true;
  if (typeof toolChoice === "object" && toolChoice !== null && toolChoice.type === "function") {
    return true;
  }
  const text = prompt;
  const explicitTool = /\b(?:use|call|invoke)\s+(?:the\s+)?[\w.-]+\s+(?:tool|function|api)\b|\btool[_ -]?call\b|使用.{0,20}(?:工具|函数|接口)|调用.{0,20}(?:工具|函数|接口)/i;
  const codeEnvironment = /\b(?:run|execute)\s+(?:the\s+)?(?:tests?|command|script|build|linter)|\b(?:edit|modify|patch|create|write|save|delete|rename|move|inspect|read)\b.{0,60}\b(?:file|repository|repo|codebase|directory|folder)\b|\b(?:terminal|shell|bash|zsh|pytest|npm test|pnpm test|git\s+(?:status|diff|commit)|docker)\b|(?:运行|执行).{0,20}(?:测试|命令|脚本|构建)|(?:修改|编辑|修复|创建|读取|检查|保存).{0,30}(?:文件|仓库|代码库|目录)/i;
  const webAction = /\b(?:browse|search|look up|fetch|open)\b.{0,80}\b(?:web|website|url|online|documentation|docs|news|weather|price)\b|(?:浏览|搜索|查询|打开).{0,30}(?:网页|网站|链接|文档|新闻|天气|价格)/i;
  const statefulAction = /\b(?:refund|cancel|book|reserve|purchase|buy|return|exchange|transfer|update|change)\b.{0,80}\b(?:order|booking|reservation|account|address|payment|subscription|ticket|flight|item)\b|(?:退款|取消|预订|购买|退货|换货|转账|更新|修改).{0,30}(?:订单|预订|账户|地址|付款|订阅|票|航班|商品)/i;
  return explicitTool.test(text) || codeEnvironment.test(text) || webAction.test(text) || statefulAction.test(text);
}
var DEFAULT_PORTFOLIO_WEIGHTS = {
  auto: {
    quality: 0.47,
    capability: 0.2,
    cost: 0.18,
    speed: 0.07,
    reliability: 0.03,
    legacy: 0.05
  },
  eco: { quality: 0.36, capability: 0.2, cost: 0.28, speed: 0.1, reliability: 0.04, legacy: 0.02 },
  premium: {
    quality: 0.58,
    capability: 0.2,
    cost: 0.08,
    speed: 0.06,
    reliability: 0.06,
    legacy: 0.02
  },
  highStakesBoost: { quality: 0.08, reliability: 0.05 },
  latencySensitiveSpeedBoost: 0.08,
  affinityFloorGap: { auto: 0.1, eco: 0.22, premium: 0.05 }
};
function likelyNeedsParallelToolCalls(prompt, needsTools, toolCount, toolNames) {
  if (!needsTools || toolCount === void 0 || toolCount < 1) return false;
  const text = prompt.trim();
  const explicitRepeat = /\b(?:in parallel|simultaneously|concurrently|for each|each of|every one|both|(?:two|three|multiple|several)\s+(?:cities|locations|items|tasks|orders|users|files))\b|并行|同时|分别|每个|各自|(?:两个|三个|多个)(?:城市|地点|项目|任务|订单|用户|文件)|cada uno|para cada|simult[aá]neamente/i.test(
    text
  );
  if (explicitRepeat) return true;
  const sentenceClauses = text.split(/[.!?。！？]+/).map((part) => part.trim()).filter((part) => part.length >= 8);
  if (/\b(?:also|additionally|furthermore)\b|另外|此外|그리고/i.test(text) && sentenceClauses.length >= 2 || /\band\s+(?:also|for the)\b/i.test(text))
    return true;
  const pairedQuantity = /\b\d+(?:\.\d+)?\s+(?:and|or)\s+\d+(?:\.\d+)?\s*(?:gb|mb|tb|kg|g|ml|oz|cups?|cores?|cpus?)\b/i.test(
    text
  );
  if (pairedQuantity) return true;
  const operationTokens = /* @__PURE__ */ new Set([
    "add",
    "delete",
    "remove",
    "cancel",
    "return",
    "exchange",
    "modify",
    "book",
    "transfer",
    "send",
    "upload",
    "download",
    "create",
    "close"
  ]);
  const lowered = text.toLowerCase();
  const matchedOperationTokens = new Set(
    (toolNames ?? []).flatMap((name) => name.toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/)).filter((token) => operationTokens.has(token) && lowered.includes(token))
  );
  if (matchedOperationTokens.size >= 2) return true;
  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const quantityMentions = text.match(
    /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:oz|ounce|ounces|g|gram|grams|kg|ml|cups?|pieces?|tablespoons?)\b/gi
  ) ?? [];
  if (nonEmptyLines.length >= 2 && quantityMentions.length >= 2) return true;
  const repeatedLookup = /\b(?:weather|climate|clima|tiempo|temperature|snow|news|report)\b|天气|气象|温度|降雪|新闻|报告/i.test(
    text
  );
  const multiLocationConnector = /\b(?:and also|both|y|e)\b|还有|以及|和|、/i.test(text);
  const commaSeparatedLocations = (text.match(/[,，]/g) ?? []).length >= 2;
  if (repeatedLookup && (multiLocationConnector || commaSeparatedLocations)) return true;
  const distinctOrderParts = /\b(?:food|meal)\b[\s\S]*\bdrink\b|\bdrink\b[\s\S]*\b(?:food|meal)\b/i.test(text);
  const koreanParallelClauses = (text.match(/,/g) ?? []).length >= 3 && /하고|그리고/.test(text);
  return distinctOrderParts || koreanParallelClauses;
}
function classifyTask(prompt, systemPrompt, options) {
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedInputTokens = Math.ceil(fullText.length / 4);
  const scanLimit = Math.max(1, Math.min(8e3, options.config.classifier.promptTruncationChars));
  const sample = (value) => {
    if (value.length <= scanLimit) return value;
    const prefixLength = Math.ceil(scanLimit / 2);
    return `${value.slice(0, prefixLength)}
${value.slice(-(scanLimit - prefixLength))}`;
  };
  const scannedPrompt = sample(prompt);
  const scannedSystemPrompt = sample(systemPrompt ?? "");
  const scannedFullText = `${scannedSystemPrompt} ${scannedPrompt}`;
  const text = scannedPrompt.toLowerCase();
  const explicitCodeSignal = /```|\b(?:typescript|javascript|python|rust|java|sql|stack trace|traceback|exception)\b|\.(?:ts|tsx|js|py|go|rs)\b/i.test(
    scannedPrompt
  );
  const codeConstructSignal = /\b(?:implement|refactor|debug|write|edit|modify|create|define|review|fix)\b[\s\S]{0,48}\b(?:api|function|class|method)\b|\b(?:api|function|class|method)\b[\s\S]{0,48}\b(?:code|implementation|typescript|javascript|python|rust|java)\b/i.test(
    scannedPrompt
  );
  const nativeCodeSignal = /\b(?:programmed|written|implemented?|code)\s+(?:in|using)\s+(?:c\+\+|c|rust|go)\b/i.test(
    scannedPrompt
  );
  const hasCode = explicitCodeSignal || codeConstructSignal || nativeCodeSignal;
  const toolsAvailable = options.hasTools ?? false;
  const needsTools = options.requiresTools ?? (toolsAvailable && inferToolRequirement(scannedPrompt, scannedSystemPrompt));
  const likelyParallelToolCalls = likelyNeedsParallelToolCalls(
    scannedPrompt,
    needsTools,
    options.toolCount,
    options.toolNames
  );
  const normalizedToolNames = (options.toolNames ?? []).map((name) => name.toLowerCase());
  const airlineToolSignal = normalizedToolNames.some(
    (name) => /(?:flight|reservation|airport|baggage|passenger)/.test(name)
  );
  const retailToolSignal = normalizedToolNames.some(
    (name) => /(?:order|product|item|return|exchange|address)/.test(name)
  );
  const webResearchToolSignal = normalizedToolNames.some(
    (name) => /^(?:web_?search|web_?fetch)$/.test(name)
  );
  const agentDomain = airlineToolSignal && !retailToolSignal ? "airline" : retailToolSignal && !airlineToolSignal ? "retail" : webResearchToolSignal ? "web_research" : "other";
  const clueConnectors = scannedFullText.match(
    /\b(?:after|before|while|where|whose|which|in \d{4}|as of|over \d+|another|also|furthermore)\b|(?:之后|之前|其中|截至|超过|另一个|此外)/gi
  ) ?? [];
  const entityResolutionSignal = /\b(?:identify|who (?:is|was)|what (?:is|was) the name|which (?:person|player|company|country|city)|find the (?:person|player|name|entity))\b|(?:找出|识别|是谁|哪位|名称是什么)/i.test(
    scannedFullText
  );
  const exactAnswerSignal = /\b(?:exact answer|single best-supported answer|following clues|multiple public sources)\b|(?:精确答案|根据.*线索|多个公开来源)/i.test(
    scannedFullText
  );
  const deepWebResearch = agentDomain === "web_research" && (exactAnswerSignal || entityResolutionSignal && (clueConnectors.length >= 3 || prompt.length >= 320));
  const globalOptimizationSignal = /\b(?:cheapest|lowest[- ]price|least expensive|most expensive|highest(?:[- ]priced)?|largest|smallest|maximum|minimum|best available|closest|not (?:cost|exceed))\b|最便宜|最低价|最贵|最高价|最大|最小/i.test(
    scannedPrompt
  );
  const globalScopeSignal = /\b(?:everything|all (?:(?:my|your|their|the) )?(?:future |upcoming )?(?:items|orders|passengers|flights|reservations|bookings)|every (?:item|order|passenger|flight|reservation|booking))\b|全部|所有|每个/i.test(
    scannedPrompt
  );
  const globalChoiceSignal = globalOptimizationSignal || globalScopeSignal;
  const crossRecordSignal = /\b(?:another|other|different|previous)\s+(?:order|reservation|booking|account|address)\b|另一(?:个)?(?:订单|预订|账户|地址)|其他(?:订单|预订|账户|地址)/i.test(
    scannedPrompt
  );
  const reservationIds = scannedPrompt.match(/\b[A-Z0-9]{6}\b/g) ?? [];
  const crossReservationBatchSignal = agentDomain === "airline" && (/\b(?:two|three|multiple|several)(?:\s+of\s+(?:my|our|the))?\s+(?:upcoming\s+)?(?:reservations?|bookings?)\b|\b(?:a\s+)?(?:second|third)\s+(?:reservation|booking)\b/i.test(
    scannedPrompt
  ) || new Set(reservationIds).size >= 2);
  const conditionalGlobalWorkflowSignal = agentDomain === "airline" && globalScopeSignal && /\b(?:if|that (?:contain|have)|longer than|shorter than|under|over|at (?:most|least)|wherever possible)\b|如果|超过|少于|不超过|尽可能/i.test(
    scannedPrompt
  ) && /\b(?:cancel|change|upgrade|move|book)\b[\s\S]*\b(?:cancel|change|upgrade|move|book)\b|取消[\s\S]*(?:升级|更改)|升级[\s\S]*(?:取消|更改)/i.test(
    scannedPrompt
  );
  const policyExceptionSignal = agentDomain === "retail" && /\b(?:return|refund|send back|get (?:my |the )?money back)\b|退货|退款|退回/i.test(
    scannedPrompt
  ) && /\b(?:amex|american express|visa|mastercard|credit card|debit card|different card|another card|other card)\b|信用卡|借记卡|其他卡|另一张卡/i.test(
    scannedPrompt
  );
  const singleSelectedPolicyException = policyExceptionSignal && /\b(?:return|refund|send back)\b[^.!?。！？]{0,96}\b(?:the )?(?:pricier|cheaper|more expensive|less expensive|costlier|one)\b/i.test(
    scannedPrompt
  );
  const negotiatedWorkflowSignal = agentDomain === "retail" && /\b(?:return|exchange)\b|退货|退回|换货|交换/i.test(scannedPrompt);
  const numberedSteps = (scannedPrompt.match(/(?:^|\s)\d+(?:\.\d+)*[.)]\s+/g) ?? []).length;
  const complexMultiToolPlan = likelyParallelToolCalls && ((options.toolCount ?? 0) >= 6 || numberedSteps >= 3 || prompt.length > 1200);
  let agentRisk = needsTools && singleSelectedPolicyException ? "policy_exception_simple" : needsTools && policyExceptionSignal ? "policy_exception" : (
    // Airline prompts that require a global optimum (for example the
    // cheapest itinerary across several candidates) are materially harder
    // than applying one change to every passenger in a known reservation.
    // Full-session evidence supports Sonnet for the former, while upgrading
    // the latter merely because it says "all passengers" caused a large cost
    // increase without a quality gain.
    needsTools && agentDomain === "airline" && (globalOptimizationSignal || conditionalGlobalWorkflowSignal) ? "complex_high" : needsTools && (likelyParallelToolCalls || globalChoiceSignal || crossRecordSignal || crossReservationBatchSignal || negotiatedWorkflowSignal) ? "high" : "standard"
  );
  const needsVision = options.hasVision ?? false;
  const needsStructuredOutput = options.requiresStructuredOutput ?? false;
  const latencySensitive = /\b(?:urgent|asap|fast|quick|low latency|real[- ]time)\b|尽快|马上|快速|低延迟/i.test(
    scannedFullText
  );
  const highStakes = /\b(?:production|security|payment|legal|medical|financial|audit)\b|生产|安全|支付|法律|医疗|财务|审计/i.test(
    scannedFullText
  );
  const terminalToolSignal = normalizedToolNames.some(
    (name) => /^(?:terminalexec|terminalinspect|terminalsendkeys)$/.test(name)
  );
  const simpleTerminalArtifact = /\b(?:create|write|convert|generate|build|implement|run|fix|repair|debug|make)\b[\s\S]{0,120}\b(?:file|script|csv|parquet|json|txt|server|endpoint)\b/i.test(
    scannedPrompt
  );
  const terminalComplexRepair = terminalToolSignal && /\b(?:multiple|several)\s+(?:scripts?|files?|components?)\b|\b(?:pipeline|dependencies)\b[\s\S]{0,100}\b(?:fail|issue|fix|repair|run|execute)\b|\b(?:identify|find|fix|repair)\s+(?:and\s+)?(?:fix\s+)?all\s+(?:the\s+)?issues\b/i.test(
    scannedPrompt
  );
  const mentionedTerminalRuntimes = new Set(
    (scannedPrompt.match(/\b(?:gcc|clang|rustc|javac|go\s+build|node|python)\b/gi) ?? []).map(
      (name) => name.toLowerCase().replace(/\s+/g, " ")
    )
  );
  const terminalCrossRuntimeArtifact = terminalToolSignal && (/\bpolyglot\b/i.test(scannedPrompt) || /\b(?:both|each)\b[\s\S]{0,120}\b(?:compilers?|runtimes?|toolchains?)\b/i.test(
    scannedPrompt
  ) || mentionedTerminalRuntimes.size >= 2 && /\b(?:compile|build|run|execute)\b/i.test(scannedPrompt));
  const terminalFrameworkToNativeArtifact = terminalToolSignal && /\b(?:pytorch|tensorflow|jax|onnx|state[_ -]?dict|checkpoint|safetensors?)\b|\.(?:pth|pt|onnx)\b/i.test(
    scannedPrompt
  ) && /\b(?:pure|native|programmed|written|implemented?)\s+(?:in|using)\s+(?:c\+\+|c|rust|go)\b|\b(?:c\+\+|c|rust|go)\s+(?:program|binary|executable|cli|tool|implementation)\b/i.test(
    scannedPrompt
  ) && /\b(?:inference|model|weights?|tensor|export|convert|load)\b/i.test(scannedPrompt);
  if (needsTools && (terminalComplexRepair || terminalCrossRuntimeArtifact || terminalFrameworkToNativeArtifact) && (agentRisk === "standard" || agentRisk === "high"))
    agentRisk = "complex_high";
  const complexTerminalOperation = /\b(?:git|ssh|nginx|https|certificate|authentication|credential|deploy|production|encrypt|gpg|shred|securely delete|decommission|benchmark|evaluate|embedding|chess|image|search the web|schema|statistical|statistics|aggregate|join|multiple inputs?)\b/i.test(
    scannedPrompt
  );
  const terminalCredentialSignal = /\b(?:ssh|nginx|certificate|authentication|credentials?|passwords?|api keys?|deploy|production|encrypt|gpg|shred|securely delete|decommission)\b/i.test(
    scannedPrompt
  ) || /\b(?:access|auth|authentication|bearer|secret|api)\s+tokens?\b|\btokens?\s+(?:secret|credential|authentication)\b/i.test(
    scannedPrompt
  );
  const terminalSafetySensitive = terminalToolSignal && (highStakes || terminalCredentialSignal);
  const implicitTerminalCode = needsTools && terminalToolSignal && agentRisk === "standard" && !highStakes && !complexTerminalOperation && numberedSteps < 3 && prompt.length <= 1e3 && simpleTerminalArtifact;
  const language = /[\u3400-\u9fff]/.test(scannedFullText) ? "zh" : "other";
  const multipleChoiceSignals = (scannedPrompt.match(/(?:^|\n)\s*[A-D][.)]\s+/gim) ?? []).length;
  const numericSignals = (scannedPrompt.match(/-?\d+(?:[.,]\d+)?/g) ?? []).length;
  const compactMathProblem = !hasCode && prompt.length < 2500 && numericSignals >= 2 && (/[+×÷=%$€£¥]|\b(?:total|each|per|times|half|twice|percent|how many|how much|calculate)\b/i.test(
    scannedPrompt
  ) || /[?？]\s*$/.test(scannedPrompt.trim()) || numericSignals >= 3);
  let taskType = "chat";
  if (needsVision) taskType = "vision";
  else if (estimatedInputTokens > 8e4) taskType = "long_context";
  else if (needsTools && (hasCode || implicitTerminalCode)) taskType = "code_agent";
  else if (needsTools && likelyParallelToolCalls && !complexMultiToolPlan)
    taskType = "tool_agent_parallel";
  else if (needsTools) taskType = "tool_agent";
  else if (multipleChoiceSignals >= 3) taskType = "reasoning_mcq";
  else if (compactMathProblem) taskType = "reasoning_math";
  else if (/\b(?:bug|debug|error|failure|failing|regression|crash|修复|报错|错误|调试)\b/i.test(text))
    taskType = "debug";
  else if (hasCode || /\b(?:refactor|implement|patch|edit|rewrite|重构|实现|修改)\b/i.test(text))
    taskType = "code_edit";
  else if (needsStructuredOutput || /\b(?:extract|json|schema|csv|字段|提取)\b/i.test(text))
    taskType = "extraction";
  else if (/\b(?:prove|derive|theorem|formal|mathematical|reasoning|证明|推导|定理|数学)\b/i.test(text))
    taskType = "reasoning";
  return {
    taskType,
    estimatedInputTokens,
    hasCode,
    needsTools,
    toolsAvailable,
    needsVision,
    needsStructuredOutput,
    latencySensitive,
    highStakes,
    language,
    likelyParallelToolCalls,
    complexMultiToolPlan,
    agentDomain,
    deepWebResearch,
    agentRisk,
    terminalToolSignal,
    terminalSafetySensitive,
    implicitTerminalCode
  };
}
function affinity(modelId, task, language = "other", agentDomain = "other", deepWebResearch = false, agentRisk = "standard", terminalToolSignal = false, terminalSafetySensitive = false) {
  const id = modelId.toLowerCase();
  const modelName = id.slice(id.indexOf("/") + 1);
  const match = (values, score) => values.some((value) => modelName === value) ? score : 0;
  const base = 0.68;
  switch (task) {
    case "code_agent":
      if (terminalToolSignal && agentRisk === "complex_high") {
        return Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5.3-codex"], 0.87),
          match(["gpt-5-mini"], 0.78),
          match(["gemini-3.5-flash"], 0.76)
        );
      }
      return Math.max(
        base,
        match(["gpt-5.3-codex"], 1),
        match(["claude-sonnet-5"], 0.98),
        match(["gpt-5-mini"], 0.96),
        match(["gemini-3.5-flash"], 0.92),
        match(["kimi-k3"], 0.9),
        match(["deepseek-v4-pro", "glm-5.2"], 0.88)
      );
    case "tool_agent":
      if (terminalToolSignal && agentRisk === "complex_high") {
        return Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5.3-codex"], 0.87),
          match(["gpt-5-mini"], 0.78),
          match(["gemini-3.5-flash"], 0.76)
        );
      }
      if (terminalToolSignal && !terminalSafetySensitive) {
        return Math.max(
          base,
          match(["gpt-5-mini"], 1),
          match(["gpt-5.3-codex"], 0.98),
          match(["claude-sonnet-5"], 0.9),
          match(["gemini-3.5-flash"], 0.89)
        );
      }
      if (terminalToolSignal && terminalSafetySensitive) {
        return Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["claude-opus-4.8"], 0.9),
          match(["gpt-5.3-codex"], 0.84)
        );
      }
      if (agentDomain === "web_research") {
        return deepWebResearch ? Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5-mini"], 0.88),
          match(["gemini-3.5-flash"], 0.84),
          match(["claude-opus-5"], 0.8),
          match(["claude-opus-4.8"], 0.78)
        ) : Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5-mini"], 0.88),
          match(["gemini-3.5-flash"], 0.86),
          match(["claude-opus-5"], 0.84),
          match(["claude-opus-4.8"], 0.82)
        );
      }
      if (agentDomain === "retail") {
        if (agentRisk === "standard") {
          return Math.max(
            base,
            match(["gpt-5-mini"], 1),
            match(["claude-sonnet-5"], 0.88),
            match(["gemini-3.5-flash"], 0.82),
            match(["gpt-5.3-codex"], 0.81),
            match(["kimi-k3"], 0.78),
            match(["deepseek-v4-pro"], 0.76)
          );
        }
        if (agentRisk === "policy_exception") {
          return Math.max(
            base,
            match(["gpt-4.1"], 1),
            match(["claude-sonnet-5"], 0.9),
            match(["deepseek-v4-pro"], 0.82),
            match(["gpt-5-mini"], 0.8),
            match(["gpt-4o-mini"], 0.76)
          );
        }
        if (agentRisk === "policy_exception_simple") {
          return Math.max(
            base,
            match(["gpt-5-mini"], 1),
            match(["gpt-4.1"], 0.86),
            match(["deepseek-v4-pro"], 0.82),
            match(["gpt-4o-mini"], 0.8)
          );
        }
        return Math.max(
          base,
          match(["deepseek-v4-pro"], 1),
          match(["claude-sonnet-5"], 0.88),
          match(["gemini-3.5-flash"], 0.82),
          match(["gpt-5.3-codex"], 0.81),
          match(["kimi-k3"], 0.78),
          match(["gpt-5-mini"], 0.76)
        );
      }
      if (agentDomain === "airline") {
        if (agentRisk === "complex_high") {
          return Math.max(
            base,
            match(["claude-sonnet-5"], 1),
            match(["gpt-5-mini"], 0.78),
            match(["gemini-3.5-flash"], 0.76),
            match(["deepseek-v4-pro"], 0.74)
          );
        }
        return Math.max(
          base,
          match(["gpt-5-mini"], 1),
          match(["claude-sonnet-5"], 0.9),
          match(["gemini-3.5-flash"], 0.8),
          match(["deepseek-v4-pro"], 0.76)
        );
      }
      return Math.max(
        base,
        match(["claude-sonnet-5"], 1),
        match(["gemini-3.5-flash"], 0.88),
        match(["gpt-5.3-codex"], 0.87),
        match(["gpt-5-mini"], 0.84),
        match(["kimi-k3"], 0.85),
        match(["deepseek-v4-pro"], 0.82)
      );
    case "tool_agent_parallel":
      if (terminalToolSignal) {
        return terminalSafetySensitive ? Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["claude-opus-4.8"], 0.9),
          match(["gpt-5.3-codex"], 0.86)
        ) : Math.max(
          base,
          match(["gpt-5-mini"], 1),
          match(["gpt-5.3-codex"], 0.98),
          match(["claude-sonnet-5"], 0.92),
          match(["gemini-3.5-flash"], 0.88)
        );
      }
      if (agentDomain === "web_research") {
        return deepWebResearch ? Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5-mini"], 0.88),
          match(["gemini-3.5-flash"], 0.84),
          match(["claude-opus-5"], 0.8),
          match(["claude-opus-4.8"], 0.78)
        ) : Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5-mini"], 0.88),
          match(["gemini-3.5-flash"], 0.86),
          match(["claude-opus-5"], 0.84),
          match(["claude-opus-4.8"], 0.82)
        );
      }
      if (agentDomain === "retail") {
        if (agentRisk === "policy_exception") {
          return Math.max(
            base,
            match(["gpt-4.1"], 1),
            match(["claude-sonnet-5"], 0.9),
            match(["deepseek-v4-pro"], 0.82),
            match(["gpt-5-mini"], 0.8),
            match(["gpt-4o-mini"], 0.76)
          );
        }
        if (agentRisk === "policy_exception_simple") {
          return Math.max(
            base,
            match(["gpt-5-mini"], 1),
            match(["gpt-4.1"], 0.86),
            match(["deepseek-v4-pro"], 0.82),
            match(["gpt-4o-mini"], 0.8)
          );
        }
        return Math.max(
          base,
          match(["deepseek-v4-pro"], 1),
          match(["claude-sonnet-5"], 0.88),
          match(["claude-opus-4.8"], 0.84),
          match(["gpt-5-mini"], 0.78),
          match(["gemini-3.5-flash"], 0.76)
        );
      }
      if (agentDomain === "airline") {
        return agentRisk === "complex_high" ? Math.max(
          base,
          match(["claude-sonnet-5"], 1),
          match(["gpt-5-mini"], 0.78),
          match(["claude-opus-4.8"], 0.76),
          match(["gemini-3.5-flash"], 0.74)
        ) : Math.max(
          base,
          match(["gpt-5-mini"], 1),
          match(["claude-sonnet-5"], 0.9),
          match(["gemini-3.5-flash"], 0.8)
        );
      }
      return Math.max(
        base,
        match(["claude-opus-4.8"], 1),
        match(["claude-sonnet-5"], 0.84),
        match(["grok-4.5"], 0.82),
        match(["gemini-3.5-flash"], 0.8),
        match(["deepseek-v4-pro"], 0.78)
      );
    case "code_edit":
    case "debug":
      return Math.max(
        base,
        match(["gpt-5.3-codex"], 1),
        match(["claude-sonnet-4.6"], 0.94),
        match(["glm-5.2"], 0.9),
        match(["deepseek-v4-pro"], 0.86)
      );
    case "reasoning":
      return Math.max(
        base,
        match(["claude-sonnet-5", "claude-sonnet-4.6"], 0.98),
        match(["deepseek-v4-pro"], 0.95),
        match(["grok-4.5"], 0.94),
        match(["gemini-3.1-pro", "gemini-3.5-flash"], 0.92)
      );
    case "reasoning_mcq":
      return Math.max(
        base,
        match(["gemini-3-flash-preview"], 1),
        match(["gemini-3.5-flash"], 0.91),
        match(["grok-4.5"], 0.9),
        match(["claude-sonnet-5"], 0.88),
        match(["deepseek-v4-pro"], 0.84)
      );
    case "reasoning_math":
      return Math.max(
        base,
        match(["gemini-3.5-flash"], 1),
        match(["grok-4.5"], 0.93),
        match(["claude-sonnet-5", "deepseek-v4-pro", "kimi-k3"], 0.9)
      );
    case "vision":
      return Math.max(
        base,
        match(["gemini-3.1-pro"], 0.96),
        match(["qwen3.7-max", "claude-sonnet-4.6", "kimi-k3", "grok-4.3"], 0.9)
      );
    case "long_context":
      return Math.max(
        base,
        match(["gemini-3.1-pro"], 1),
        match(["qwen3.7-max", "glm-5.2"], 0.89),
        match(["gemini-3.5-flash"], 0.88),
        match(["deepseek-v4-pro"], 0.85)
      );
    case "extraction": {
      const kimiExtractionAffinity = language === "zh" ? 1 : 0.9;
      const otherExtractionAffinity = language === "zh" ? 0.88 : 0.9;
      return Math.max(
        base,
        match(["gemini-3.5-flash", "gemini-2.5-flash", "gpt-4o-mini"], otherExtractionAffinity),
        match(["claude-sonnet-5", "claude-sonnet-4.6"], otherExtractionAffinity),
        match(["kimi-k3"], kimiExtractionAffinity)
      );
    }
    default:
      return Math.max(
        base,
        match(["gemini-3.5-flash", "gemini-2.5-flash", "kimi-k3"], 0.86)
      );
  }
}
function evidenceCandidates(task) {
  if (task === "code_agent") {
    return [
      "openai/gpt-5.3-codex",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5-mini",
      "google/gemini-3.5-flash",
      "moonshot/kimi-k3",
      "deepseek/deepseek-v4-pro"
    ];
  }
  if (task === "tool_agent") {
    return [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "openai/gpt-5-mini",
      "openai/gpt-4.1",
      "openai/gpt-4o-mini",
      "google/gemini-3.5-flash",
      "openai/gpt-5.3-codex",
      "moonshot/kimi-k3",
      "deepseek/deepseek-v4-pro"
    ];
  }
  if (task === "tool_agent_parallel") {
    return [
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5-mini",
      "openai/gpt-4.1",
      "openai/gpt-4o-mini",
      "xai/grok-4.5",
      "google/gemini-3.5-flash",
      "deepseek/deepseek-v4-pro"
    ];
  }
  if (task === "long_context") {
    return [
      "google/gemini-3.1-pro",
      "deepseek/deepseek-v4-pro",
      "qwen/qwen3.7-max",
      "zai/glm-5.2",
      "google/gemini-3.5-flash"
    ];
  }
  if (task === "reasoning_mcq") {
    return [
      "google/gemini-3-flash-preview",
      "google/gemini-3.5-flash",
      "xai/grok-4.5",
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-v4-pro"
    ];
  }
  if (task === "extraction") {
    return ["moonshot/kimi-k3", "google/gemini-3.5-flash", "anthropic/claude-sonnet-5"];
  }
  if (task === "reasoning_math") {
    return [
      "google/gemini-3.5-flash",
      "xai/grok-4.5",
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-v4-pro",
      "moonshot/kimi-k3"
    ];
  }
  return [];
}
function isEligible(modelId, features, maxOutputTokens, options) {
  const model = options.modelCapabilities?.[modelId] ?? DEFAULT_MODEL_CAPABILITIES[modelId];
  if (!model) return true;
  if (features.needsTools && !model.supportsTools) return false;
  if (features.needsVision && !model.supportsVision) return false;
  if (features.needsStructuredOutput && !model.supportsTools) return false;
  if (model.maxOutputTokens < maxOutputTokens) return false;
  return model.contextWindow >= (features.estimatedInputTokens + maxOutputTokens) * 1.1;
}
function estimatedCost(modelId, options, inputTokens, outputTokens) {
  const price = options.modelPricing.get(modelId);
  if (!price) return Number.POSITIVE_INFINITY;
  if (price.flatPrice !== void 0) return price.flatPrice;
  return (inputTokens * price.inputPrice + outputTokens * price.outputPrice) / 1e6;
}
function profileScore(modelId, options, now) {
  const profile = options.modelPerformance?.[modelId] ?? LIVE_MODEL_PROFILES[modelId] ?? HISTORICAL_MODEL_PROFILES[modelId];
  if (!profile) return void 0;
  const measuredAt = Date.parse(profile.measuredAt);
  if (!Number.isFinite(measuredAt)) return void 0;
  const ageDays = Math.max(0, (now.getTime() - measuredAt) / 864e5);
  const sampleConfidence = profile.samples === void 0 ? 1 : Math.min(1, Math.max(0, profile.samples) / 10);
  const freshness = Math.pow(0.5, ageDays / 30) * sampleConfidence;
  const quality = profile.intelligenceIndex === void 0 ? void 0 : Math.min(1, profile.intelligenceIndex / 50);
  const speed = Math.min(
    1,
    (2e3 / Math.max(500, profile.latencyMs) + profile.outputTokensPerSecond / 250) / 2
  );
  const tailSpeed = Math.min(1, 3e3 / Math.max(750, profile.p95LatencyMs ?? profile.latencyMs));
  const reliability = Math.max(0, 1 - (profile.errorRate ?? 0));
  return { quality, speed, tailSpeed, reliability, freshness };
}
var PortfolioStrategy = class {
  name = "portfolio";
  route(prompt, systemPrompt, maxOutputTokens, options) {
    const features = classifyTask(prompt, systemPrompt, options);
    const base = new RulesStrategy().route(prompt, systemPrompt, maxOutputTokens, {
      ...options,
      requiresTools: features.needsTools
    });
    const tierConfigs = base.tierConfigs;
    if (!tierConfigs) return base;
    const targetTier = (features.taskType === "reasoning_mcq" || features.taskType === "reasoning_math") && (base.tier === "SIMPLE" || base.tier === "MEDIUM") ? "REASONING" : base.tier;
    const tierConfig = tierConfigs[targetTier];
    const configuredCandidates = tierConfig ? getFallbackChain(targetTier, tierConfigs) : [];
    const unavailable = new Set(options.unavailableModels ?? []);
    const chain = [
      .../* @__PURE__ */ new Set([...configuredCandidates, ...evidenceCandidates(features.taskType)])
    ].filter(
      (model2) => typeof model2 === "string" && model2.length > 0 && !unavailable.has(model2)
    );
    const eligible = chain.filter(
      (model2) => isEligible(model2, features, maxOutputTokens, options)
    );
    const eligibleCandidates = eligible.length > 0 ? eligible : chain;
    if (eligibleCandidates.length === 0) return base;
    const profileName = options.routingProfile === "eco" ? "eco" : options.routingProfile === "premium" ? "premium" : "auto";
    const portfolio = options.config.portfolio ?? DEFAULT_PORTFOLIO_WEIGHTS;
    const getAffinity = (model2) => affinity(
      model2,
      features.taskType,
      features.language,
      features.agentDomain,
      features.deepWebResearch,
      features.agentRisk,
      features.terminalToolSignal,
      features.terminalSafetySensitive
    );
    const bestAffinity = Math.max(...eligibleCandidates.map(getAffinity));
    const specificAffinity = eligibleCandidates.filter((model2) => getAffinity(model2) > 0.68);
    const affinityPool = specificAffinity.length > 0 ? specificAffinity : [eligibleCandidates[0]];
    const affinityFloorGap = features.terminalToolSignal ? Math.max(
      portfolio.affinityFloorGap[profileName],
      features.terminalSafetySensitive ? 0.15 : 0.12
    ) : portfolio.affinityFloorGap[profileName];
    const candidates = affinityPool.filter(
      (model2) => getAffinity(model2) >= bestAffinity - affinityFloorGap
    );
    const costs = candidates.map(
      (model2) => estimatedCost(model2, options, features.estimatedInputTokens, maxOutputTokens)
    );
    const finiteCosts = costs.filter(Number.isFinite);
    const minCost = finiteCosts.length > 0 ? Math.min(...finiteCosts) : 0;
    const maxCost = finiteCosts.length > 0 ? Math.max(...finiteCosts) : 1;
    const now = options.now ?? /* @__PURE__ */ new Date();
    const profileWeights = portfolio[profileName];
    const rankedEntries = candidates.map((model2, index) => {
      const cost = estimatedCost(model2, options, features.estimatedInputTokens, maxOutputTokens);
      const costScore = Number.isFinite(cost) && maxCost > minCost ? 1 - (cost - minCost) / (maxCost - minCost) : 0.5;
      const capabilityScore = isEligible(model2, features, maxOutputTokens, options) ? 1 : 0;
      const profile = profileScore(model2, options, now);
      const observedQuality = profile?.quality === void 0 ? getAffinity(model2) : getAffinity(model2) * (1 - profile.freshness) + profile.quality * profile.freshness;
      const observedSpeed = profile ? profile.speed * profile.freshness : 0.5;
      const observedTailSpeed = profile ? profile.tailSpeed * profile.freshness : 0.5;
      const observedReliability = profile ? profile.reliability * profile.freshness + (1 - profile.freshness) : 1;
      const legacyScore = 1 - index / Math.max(1, candidates.length - 1);
      const qualityWeight = profileWeights.quality + (features.highStakes ? portfolio.highStakesBoost.quality : 0);
      const speedScore = features.latencySensitive ? observedTailSpeed : observedSpeed;
      const speedWeight = profileWeights.speed + (features.latencySensitive ? portfolio.latencySensitiveSpeedBoost : 0);
      const reliabilityWeight = profileWeights.reliability + (features.highStakes ? portfolio.highStakesBoost.reliability : 0);
      const score = observedQuality * qualityWeight + capabilityScore * profileWeights.capability + costScore * profileWeights.cost + speedScore * speedWeight + observedReliability * reliabilityWeight + legacyScore * profileWeights.legacy;
      return {
        model: model2,
        score,
        quality: observedQuality,
        cost: costScore,
        speed: speedScore,
        reliability: observedReliability
      };
    }).sort((a, b) => b.score - a.score);
    const scoredModels = rankedEntries.map((item) => item.model);
    const webResearchFallbackOrder = [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5-mini",
      "google/gemini-3.5-flash",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
      "openai/gpt-5.3-codex"
    ];
    const ranked = features.agentDomain === "web_research" ? [
      ...scoredModels,
      ...webResearchFallbackOrder.filter(
        (model2) => eligibleCandidates.includes(model2) && !scoredModels.includes(model2)
      ),
      ...eligibleCandidates.filter(
        (model2) => !scoredModels.includes(model2) && !webResearchFallbackOrder.includes(model2)
      )
    ] : [...scoredModels, ...eligibleCandidates.filter((model2) => !scoredModels.includes(model2))];
    const model = ranked[0] ?? base.model;
    const selectedTierConfigs = {
      ...tierConfigs,
      [targetTier]: { primary: model, fallback: ranked.slice(1) }
    };
    const decision = selectModel(
      targetTier,
      base.confidence,
      "portfolio",
      `${base.reasoning} | v3 task=${features.taskType} agentRisk=${features.agentRisk} deepWebResearch=${features.deepWebResearch} terminalCode=${features.implicitTerminalCode} terminalSafety=${features.terminalSafetySensitive} candidates=${ranked.length}`,
      selectedTierConfigs,
      options.modelPricing,
      features.estimatedInputTokens,
      maxOutputTokens,
      options.routingProfile,
      base.agenticScore
    );
    return {
      ...decision,
      tierConfigs: selectedTierConfigs,
      profile: base.profile,
      candidates: ranked,
      candidateScores: rankedEntries.map(({ model: model2, score, quality, cost, speed, reliability }) => ({
        model: model2,
        score,
        quality,
        cost,
        speed,
        reliability
      })),
      taskType: features.taskType,
      routerVersion: "v3-portfolio"
    };
  }
};
var DEFAULT_ROUTING_CONFIG = {
  version: "3.5",
  strategy: "portfolio",
  portfolio: {
    auto: {
      quality: 0.47,
      capability: 0.2,
      cost: 0.18,
      speed: 0.07,
      reliability: 0.03,
      legacy: 0.05
    },
    eco: {
      quality: 0.36,
      capability: 0.2,
      cost: 0.28,
      speed: 0.1,
      reliability: 0.04,
      legacy: 0.02
    },
    premium: {
      quality: 0.58,
      capability: 0.2,
      cost: 0.08,
      speed: 0.06,
      reliability: 0.06,
      legacy: 0.02
    },
    highStakesBoost: { quality: 0.08, reliability: 0.05 },
    latencySensitiveSpeedBoost: 0.08,
    affinityFloorGap: { auto: 0.1, eco: 0.22, premium: 0.05 }
  },
  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 36e5
    // 1 hour
  },
  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    // Multilingual keywords: EN + ZH + JA + RU + DE + ES + PT + KO + AR
    codeKeywords: [
      // English
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      // Chinese
      "\u51FD\u6570",
      "\u7C7B",
      "\u5BFC\u5165",
      "\u5B9A\u4E49",
      "\u67E5\u8BE2",
      "\u5F02\u6B65",
      "\u7B49\u5F85",
      "\u5E38\u91CF",
      "\u53D8\u91CF",
      "\u8FD4\u56DE",
      // Japanese
      "\u95A2\u6570",
      "\u30AF\u30E9\u30B9",
      "\u30A4\u30F3\u30DD\u30FC\u30C8",
      "\u975E\u540C\u671F",
      "\u5B9A\u6570",
      "\u5909\u6570",
      // Russian
      "\u0444\u0443\u043D\u043A\u0446\u0438\u044F",
      "\u043A\u043B\u0430\u0441\u0441",
      "\u0438\u043C\u043F\u043E\u0440\u0442",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B",
      "\u0437\u0430\u043F\u0440\u043E\u0441",
      "\u0430\u0441\u0438\u043D\u0445\u0440\u043E\u043D\u043D\u044B\u0439",
      "\u043E\u0436\u0438\u0434\u0430\u0442\u044C",
      "\u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0430",
      "\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F",
      "\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      // German
      "funktion",
      "klasse",
      "importieren",
      "definieren",
      "abfrage",
      "asynchron",
      "erwarten",
      "konstante",
      "variable",
      "zur\xFCckgeben",
      // Spanish
      "funci\xF3n",
      "clase",
      "importar",
      "definir",
      "consulta",
      "as\xEDncrono",
      "esperar",
      "constante",
      "variable",
      "retornar",
      // Portuguese
      "fun\xE7\xE3o",
      "classe",
      "importar",
      "definir",
      "consulta",
      "ass\xEDncrono",
      "aguardar",
      "constante",
      "vari\xE1vel",
      "retornar",
      // Korean
      "\uD568\uC218",
      "\uD074\uB798\uC2A4",
      "\uAC00\uC838\uC624\uAE30",
      "\uC815\uC758",
      "\uCFFC\uB9AC",
      "\uBE44\uB3D9\uAE30",
      "\uB300\uAE30",
      "\uC0C1\uC218",
      "\uBCC0\uC218",
      "\uBC18\uD658",
      // Arabic
      "\u062F\u0627\u0644\u0629",
      "\u0641\u0626\u0629",
      "\u0627\u0633\u062A\u064A\u0631\u0627\u062F",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u0627\u0633\u062A\u0639\u0644\u0627\u0645",
      "\u063A\u064A\u0631 \u0645\u062A\u0632\u0627\u0645\u0646",
      "\u0627\u0646\u062A\u0638\u0627\u0631",
      "\u062B\u0627\u0628\u062A",
      "\u0645\u062A\u063A\u064A\u0631",
      "\u0625\u0631\u062C\u0627\u0639"
    ],
    reasoningKeywords: [
      // English
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      // Chinese
      "\u8BC1\u660E",
      "\u5B9A\u7406",
      "\u63A8\u5BFC",
      "\u9010\u6B65",
      "\u601D\u7EF4\u94FE",
      "\u5F62\u5F0F\u5316",
      "\u6570\u5B66",
      "\u903B\u8F91",
      // Japanese
      "\u8A3C\u660E",
      "\u5B9A\u7406",
      "\u5C0E\u51FA",
      "\u30B9\u30C6\u30C3\u30D7\u30D0\u30A4\u30B9\u30C6\u30C3\u30D7",
      "\u8AD6\u7406\u7684",
      // Russian
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
      "\u0434\u043E\u043A\u0430\u0436\u0438",
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432",
      "\u0442\u0435\u043E\u0440\u0435\u043C\u0430",
      "\u0432\u044B\u0432\u0435\u0441\u0442\u0438",
      "\u0448\u0430\u0433 \u0437\u0430 \u0448\u0430\u0433\u043E\u043C",
      "\u043F\u043E\u0448\u0430\u0433\u043E\u0432\u043E",
      "\u043F\u043E\u044D\u0442\u0430\u043F\u043D\u043E",
      "\u0446\u0435\u043F\u043E\u0447\u043A\u0430 \u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438\u0439",
      "\u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438",
      "\u0444\u043E\u0440\u043C\u0430\u043B\u044C\u043D\u043E",
      "\u043C\u0430\u0442\u0435\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438",
      "\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438",
      // German
      "beweisen",
      "beweis",
      "theorem",
      "ableiten",
      "schritt f\xFCr schritt",
      "gedankenkette",
      "formal",
      "mathematisch",
      "logisch",
      // Spanish
      "demostrar",
      "teorema",
      "derivar",
      "paso a paso",
      "cadena de pensamiento",
      "formalmente",
      "matem\xE1tico",
      "prueba",
      "l\xF3gicamente",
      // Portuguese
      "provar",
      "teorema",
      "derivar",
      "passo a passo",
      "cadeia de pensamento",
      "formalmente",
      "matem\xE1tico",
      "prova",
      "logicamente",
      // Korean
      "\uC99D\uBA85",
      "\uC815\uB9AC",
      "\uB3C4\uCD9C",
      "\uB2E8\uACC4\uBCC4",
      "\uC0AC\uACE0\uC758 \uC5F0\uC1C4",
      "\uD615\uC2DD\uC801",
      "\uC218\uD559\uC801",
      "\uB17C\uB9AC\uC801",
      // Arabic
      "\u0625\u062B\u0628\u0627\u062A",
      "\u0646\u0638\u0631\u064A\u0629",
      "\u0627\u0634\u062A\u0642\u0627\u0642",
      "\u062E\u0637\u0648\u0629 \u0628\u062E\u0637\u0648\u0629",
      "\u0633\u0644\u0633\u0644\u0629 \u0627\u0644\u062A\u0641\u0643\u064A\u0631",
      "\u0631\u0633\u0645\u064A\u0627\u064B",
      "\u0631\u064A\u0627\u0636\u064A",
      "\u0628\u0631\u0647\u0627\u0646",
      "\u0645\u0646\u0637\u0642\u064A\u0627\u064B"
    ],
    simpleKeywords: [
      // English
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      // Chinese
      "\u4EC0\u4E48\u662F",
      "\u5B9A\u4E49",
      "\u7FFB\u8BD1",
      "\u4F60\u597D",
      "\u662F\u5426",
      "\u9996\u90FD",
      "\u591A\u5927",
      "\u8C01\u662F",
      "\u4F55\u65F6",
      // Japanese
      "\u3068\u306F",
      "\u5B9A\u7FA9",
      "\u7FFB\u8A33",
      "\u3053\u3093\u306B\u3061\u306F",
      "\u306F\u3044\u304B\u3044\u3044\u3048",
      "\u9996\u90FD",
      "\u8AB0",
      // Russian
      "\u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0434\u0438",
      "\u043F\u0440\u0438\u0432\u0435\u0442",
      "\u0434\u0430 \u0438\u043B\u0438 \u043D\u0435\u0442",
      "\u0441\u0442\u043E\u043B\u0438\u0446\u0430",
      "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043B\u0435\u0442",
      "\u043A\u0442\u043E \u0442\u0430\u043A\u043E\u0439",
      "\u043A\u043E\u0433\u0434\u0430",
      "\u043E\u0431\u044A\u044F\u0441\u043D\u0438",
      // German
      "was ist",
      "definiere",
      "\xFCbersetze",
      "hallo",
      "ja oder nein",
      "hauptstadt",
      "wie alt",
      "wer ist",
      "wann",
      "erkl\xE4re",
      // Spanish
      "qu\xE9 es",
      "definir",
      "traducir",
      "hola",
      "s\xED o no",
      "capital de",
      "cu\xE1ntos a\xF1os",
      "qui\xE9n es",
      "cu\xE1ndo",
      // Portuguese
      "o que \xE9",
      "definir",
      "traduzir",
      "ol\xE1",
      "sim ou n\xE3o",
      "capital de",
      "quantos anos",
      "quem \xE9",
      "quando",
      // Korean
      "\uBB34\uC5C7",
      "\uC815\uC758",
      "\uBC88\uC5ED",
      "\uC548\uB155\uD558\uC138\uC694",
      "\uC608 \uB610\uB294 \uC544\uB2C8\uC624",
      "\uC218\uB3C4",
      "\uB204\uAD6C",
      "\uC5B8\uC81C",
      // Arabic
      "\u0645\u0627 \u0647\u0648",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u062A\u0631\u062C\u0645",
      "\u0645\u0631\u062D\u0628\u0627",
      "\u0646\u0639\u0645 \u0623\u0648 \u0644\u0627",
      "\u0639\u0627\u0635\u0645\u0629",
      "\u0645\u0646 \u0647\u0648",
      "\u0645\u062A\u0649"
    ],
    technicalKeywords: [
      // English
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      // Chinese
      "\u7B97\u6CD5",
      "\u4F18\u5316",
      "\u67B6\u6784",
      "\u5206\u5E03\u5F0F",
      "\u5FAE\u670D\u52A1",
      "\u6570\u636E\u5E93",
      "\u57FA\u7840\u8BBE\u65BD",
      // Japanese
      "\u30A2\u30EB\u30B4\u30EA\u30BA\u30E0",
      "\u6700\u9069\u5316",
      "\u30A2\u30FC\u30AD\u30C6\u30AF\u30C1\u30E3",
      "\u5206\u6563",
      "\u30DE\u30A4\u30AF\u30ED\u30B5\u30FC\u30D3\u30B9",
      "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9",
      // Russian
      "\u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0430\u0446\u0438",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u0443\u0439",
      "\u0430\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430",
      "\u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u044B\u0439",
      "\u043C\u0438\u043A\u0440\u043E\u0441\u0435\u0440\u0432\u0438\u0441",
      "\u0431\u0430\u0437\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
      "\u0438\u043D\u0444\u0440\u0430\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430",
      // German
      "algorithmus",
      "optimieren",
      "architektur",
      "verteilt",
      "kubernetes",
      "mikroservice",
      "datenbank",
      "infrastruktur",
      // Spanish
      "algoritmo",
      "optimizar",
      "arquitectura",
      "distribuido",
      "microservicio",
      "base de datos",
      "infraestructura",
      // Portuguese
      "algoritmo",
      "otimizar",
      "arquitetura",
      "distribu\xEDdo",
      "microsservi\xE7o",
      "banco de dados",
      "infraestrutura",
      // Korean
      "\uC54C\uACE0\uB9AC\uC998",
      "\uCD5C\uC801\uD654",
      "\uC544\uD0A4\uD14D\uCC98",
      "\uBD84\uC0B0",
      "\uB9C8\uC774\uD06C\uB85C\uC11C\uBE44\uC2A4",
      "\uB370\uC774\uD130\uBCA0\uC774\uC2A4",
      "\uC778\uD504\uB77C",
      // Arabic
      "\u062E\u0648\u0627\u0631\u0632\u0645\u064A\u0629",
      "\u062A\u062D\u0633\u064A\u0646",
      "\u0628\u0646\u064A\u0629",
      "\u0645\u0648\u0632\u0639",
      "\u062E\u062F\u0645\u0629 \u0645\u0635\u063A\u0631\u0629",
      "\u0642\u0627\u0639\u062F\u0629 \u0628\u064A\u0627\u0646\u0627\u062A",
      "\u0628\u0646\u064A\u0629 \u062A\u062D\u062A\u064A\u0629"
    ],
    creativeKeywords: [
      // English
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      // Chinese
      "\u6545\u4E8B",
      "\u8BD7",
      "\u521B\u4F5C",
      "\u5934\u8111\u98CE\u66B4",
      "\u521B\u610F",
      "\u60F3\u8C61",
      "\u5199\u4E00\u4E2A",
      // Japanese
      "\u7269\u8A9E",
      "\u8A69",
      "\u4F5C\u66F2",
      "\u30D6\u30EC\u30A4\u30F3\u30B9\u30C8\u30FC\u30E0",
      "\u5275\u9020\u7684",
      "\u60F3\u50CF",
      // Russian
      "\u0438\u0441\u0442\u043E\u0440\u0438\u044F",
      "\u0440\u0430\u0441\u0441\u043A\u0430\u0437",
      "\u0441\u0442\u0438\u0445\u043E\u0442\u0432\u043E\u0440\u0435\u043D\u0438\u0435",
      "\u0441\u043E\u0447\u0438\u043D\u0438\u0442\u044C",
      "\u0441\u043E\u0447\u0438\u043D\u0438",
      "\u043C\u043E\u0437\u0433\u043E\u0432\u043E\u0439 \u0448\u0442\u0443\u0440\u043C",
      "\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u043F\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C",
      "\u043F\u0440\u0438\u0434\u0443\u043C\u0430\u0439",
      "\u043D\u0430\u043F\u0438\u0448\u0438",
      // German
      "geschichte",
      "gedicht",
      "komponieren",
      "brainstorming",
      "kreativ",
      "vorstellen",
      "schreibe",
      "erz\xE4hlung",
      // Spanish
      "historia",
      "poema",
      "componer",
      "lluvia de ideas",
      "creativo",
      "imaginar",
      "escribe",
      // Portuguese
      "hist\xF3ria",
      "poema",
      "compor",
      "criativo",
      "imaginar",
      "escreva",
      // Korean
      "\uC774\uC57C\uAE30",
      "\uC2DC",
      "\uC791\uACE1",
      "\uBE0C\uB808\uC778\uC2A4\uD1A0\uBC0D",
      "\uCC3D\uC758\uC801",
      "\uC0C1\uC0C1",
      "\uC791\uC131",
      // Arabic
      "\u0642\u0635\u0629",
      "\u0642\u0635\u064A\u062F\u0629",
      "\u062A\u0623\u0644\u064A\u0641",
      "\u0639\u0635\u0641 \u0630\u0647\u0646\u064A",
      "\u0625\u0628\u062F\u0627\u0639\u064A",
      "\u062A\u062E\u064A\u0644",
      "\u0627\u0643\u062A\u0628"
    ],
    // New dimension keyword lists (multilingual)
    imperativeVerbs: [
      // English
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      // Chinese
      "\u6784\u5EFA",
      "\u521B\u5EFA",
      "\u5B9E\u73B0",
      "\u8BBE\u8BA1",
      "\u5F00\u53D1",
      "\u751F\u6210",
      "\u90E8\u7F72",
      "\u914D\u7F6E",
      "\u8BBE\u7F6E",
      // Japanese
      "\u69CB\u7BC9",
      "\u4F5C\u6210",
      "\u5B9F\u88C5",
      "\u8A2D\u8A08",
      "\u958B\u767A",
      "\u751F\u6210",
      "\u30C7\u30D7\u30ED\u30A4",
      "\u8A2D\u5B9A",
      // Russian
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0439",
      "\u0441\u043E\u0437\u0434\u0430\u0442\u044C",
      "\u0441\u043E\u0437\u0434\u0430\u0439",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u0443\u0439",
      "\u0441\u043F\u0440\u043E\u0435\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0439",
      "\u0441\u043A\u043E\u043D\u0441\u0442\u0440\u0443\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0438",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0439",
      // German
      "erstellen",
      "bauen",
      "implementieren",
      "entwerfen",
      "entwickeln",
      "konstruieren",
      "generieren",
      "bereitstellen",
      "konfigurieren",
      "einrichten",
      // Spanish
      "construir",
      "crear",
      "implementar",
      "dise\xF1ar",
      "desarrollar",
      "generar",
      "desplegar",
      "configurar",
      // Portuguese
      "construir",
      "criar",
      "implementar",
      "projetar",
      "desenvolver",
      "gerar",
      "implantar",
      "configurar",
      // Korean
      "\uAD6C\uCD95",
      "\uC0DD\uC131",
      "\uAD6C\uD604",
      "\uC124\uACC4",
      "\uAC1C\uBC1C",
      "\uBC30\uD3EC",
      "\uC124\uC815",
      // Arabic
      "\u0628\u0646\u0627\u0621",
      "\u0625\u0646\u0634\u0627\u0621",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u062A\u0635\u0645\u064A\u0645",
      "\u062A\u0637\u0648\u064A\u0631",
      "\u062A\u0648\u0644\u064A\u062F",
      "\u0646\u0634\u0631",
      "\u0625\u0639\u062F\u0627\u062F"
    ],
    constraintIndicators: [
      // English
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      // Chinese
      "\u4E0D\u8D85\u8FC7",
      "\u81F3\u5C11",
      "\u6700\u591A",
      "\u5728\u5185",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u9650\u5236",
      "\u9884\u7B97",
      // Japanese
      "\u4EE5\u4E0B",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u5236\u9650",
      "\u4E88\u7B97",
      // Russian
      "\u043D\u0435 \u0431\u043E\u043B\u0435\u0435",
      "\u043D\u0435 \u043C\u0435\u043D\u0435\u0435",
      "\u043A\u0430\u043A \u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445",
      "\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C",
      "\u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435",
      "\u0431\u044E\u0434\u0436\u0435\u0442",
      // German
      "h\xF6chstens",
      "mindestens",
      "innerhalb",
      "nicht mehr als",
      "maximal",
      "minimal",
      "grenze",
      "budget",
      // Spanish
      "como m\xE1ximo",
      "al menos",
      "dentro de",
      "no m\xE1s de",
      "m\xE1ximo",
      "m\xEDnimo",
      "l\xEDmite",
      "presupuesto",
      // Portuguese
      "no m\xE1ximo",
      "pelo menos",
      "dentro de",
      "n\xE3o mais que",
      "m\xE1ximo",
      "m\xEDnimo",
      "limite",
      "or\xE7amento",
      // Korean
      "\uC774\uD558",
      "\uC774\uC0C1",
      "\uCD5C\uB300",
      "\uCD5C\uC18C",
      "\uC81C\uD55C",
      "\uC608\uC0B0",
      // Arabic
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0643\u062B\u0631",
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644",
      "\u0636\u0645\u0646",
      "\u0644\u0627 \u064A\u0632\u064A\u062F \u0639\u0646",
      "\u0623\u0642\u0635\u0649",
      "\u0623\u062F\u0646\u0649",
      "\u062D\u062F",
      "\u0645\u064A\u0632\u0627\u0646\u064A\u0629"
    ],
    outputFormatKeywords: [
      // English
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      // Chinese
      "\u8868\u683C",
      "\u683C\u5F0F\u5316\u4E3A",
      "\u7ED3\u6784\u5316",
      // Japanese
      "\u30C6\u30FC\u30D6\u30EB",
      "\u30D5\u30A9\u30FC\u30DE\u30C3\u30C8",
      "\u69CB\u9020\u5316",
      // Russian
      "\u0442\u0430\u0431\u043B\u0438\u0446\u0430",
      "\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u0430\u043A",
      "\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439",
      // German
      "tabelle",
      "formatieren als",
      "strukturiert",
      // Spanish
      "tabla",
      "formatear como",
      "estructurado",
      // Portuguese
      "tabela",
      "formatar como",
      "estruturado",
      // Korean
      "\uD14C\uC774\uBE14",
      "\uD615\uC2DD",
      "\uAD6C\uC870\uD654",
      // Arabic
      "\u062C\u062F\u0648\u0644",
      "\u062A\u0646\u0633\u064A\u0642",
      "\u0645\u0646\u0638\u0645"
    ],
    referenceKeywords: [
      // English
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      // Chinese
      "\u4E0A\u9762",
      "\u4E0B\u9762",
      "\u4E4B\u524D",
      "\u63A5\u4E0B\u6765",
      "\u6587\u6863",
      "\u4EE3\u7801",
      "\u9644\u4EF6",
      // Japanese
      "\u4E0A\u8A18",
      "\u4E0B\u8A18",
      "\u524D\u306E",
      "\u6B21\u306E",
      "\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8",
      "\u30B3\u30FC\u30C9",
      // Russian
      "\u0432\u044B\u0448\u0435",
      "\u043D\u0438\u0436\u0435",
      "\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439",
      "\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439",
      "\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u0446\u0438\u044F",
      "\u043A\u043E\u0434",
      "\u0440\u0430\u043D\u0435\u0435",
      "\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
      // German
      "oben",
      "unten",
      "vorherige",
      "folgende",
      "dokumentation",
      "der code",
      "fr\xFCher",
      "anhang",
      // Spanish
      "arriba",
      "abajo",
      "anterior",
      "siguiente",
      "documentaci\xF3n",
      "el c\xF3digo",
      "adjunto",
      // Portuguese
      "acima",
      "abaixo",
      "anterior",
      "seguinte",
      "documenta\xE7\xE3o",
      "o c\xF3digo",
      "anexo",
      // Korean
      "\uC704",
      "\uC544\uB798",
      "\uC774\uC804",
      "\uB2E4\uC74C",
      "\uBB38\uC11C",
      "\uCF54\uB4DC",
      "\uCCA8\uBD80",
      // Arabic
      "\u0623\u0639\u0644\u0627\u0647",
      "\u0623\u062F\u0646\u0627\u0647",
      "\u0627\u0644\u0633\u0627\u0628\u0642",
      "\u0627\u0644\u062A\u0627\u0644\u064A",
      "\u0627\u0644\u0648\u062B\u0627\u0626\u0642",
      "\u0627\u0644\u0643\u0648\u062F",
      "\u0645\u0631\u0641\u0642"
    ],
    negationKeywords: [
      // English
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      // Chinese
      "\u4E0D\u8981",
      "\u907F\u514D",
      "\u4ECE\u4E0D",
      "\u6CA1\u6709",
      "\u9664\u4E86",
      "\u6392\u9664",
      // Japanese
      "\u3057\u306A\u3044\u3067",
      "\u907F\u3051\u308B",
      "\u6C7A\u3057\u3066",
      "\u306A\u3057\u3067",
      "\u9664\u304F",
      // Russian
      "\u043D\u0435 \u0434\u0435\u043B\u0430\u0439",
      "\u043D\u0435 \u043D\u0430\u0434\u043E",
      "\u043D\u0435\u043B\u044C\u0437\u044F",
      "\u0438\u0437\u0431\u0435\u0433\u0430\u0442\u044C",
      "\u043D\u0438\u043A\u043E\u0433\u0434\u0430",
      "\u0431\u0435\u0437",
      "\u043A\u0440\u043E\u043C\u0435",
      "\u0438\u0441\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
      "\u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435",
      // German
      "nicht",
      "vermeide",
      "niemals",
      "ohne",
      "au\xDFer",
      "ausschlie\xDFen",
      "nicht mehr",
      // Spanish
      "no hagas",
      "evitar",
      "nunca",
      "sin",
      "excepto",
      "excluir",
      // Portuguese
      "n\xE3o fa\xE7a",
      "evitar",
      "nunca",
      "sem",
      "exceto",
      "excluir",
      // Korean
      "\uD558\uC9C0 \uB9C8",
      "\uD53C\uD558\uB2E4",
      "\uC808\uB300",
      "\uC5C6\uC774",
      "\uC81C\uC678",
      // Arabic
      "\u0644\u0627 \u062A\u0641\u0639\u0644",
      "\u062A\u062C\u0646\u0628",
      "\u0623\u0628\u062F\u0627\u064B",
      "\u0628\u062F\u0648\u0646",
      "\u0628\u0627\u0633\u062A\u062B\u0646\u0627\u0621",
      "\u0627\u0633\u062A\u0628\u0639\u0627\u062F"
    ],
    domainSpecificKeywords: [
      // English
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      // Chinese
      "\u91CF\u5B50",
      "\u5149\u5B50\u5B66",
      "\u57FA\u56E0\u7EC4\u5B66",
      "\u86CB\u767D\u8D28\u7EC4\u5B66",
      "\u62D3\u6251",
      "\u540C\u6001",
      "\u96F6\u77E5\u8BC6",
      "\u683C\u5BC6\u7801",
      // Japanese
      "\u91CF\u5B50",
      "\u30D5\u30A9\u30C8\u30CB\u30AF\u30B9",
      "\u30B2\u30CE\u30DF\u30AF\u30B9",
      "\u30C8\u30DD\u30ED\u30B8\u30AB\u30EB",
      // Russian
      "\u043A\u0432\u0430\u043D\u0442\u043E\u0432\u044B\u0439",
      "\u0444\u043E\u0442\u043E\u043D\u0438\u043A\u0430",
      "\u0433\u0435\u043D\u043E\u043C\u0438\u043A\u0430",
      "\u043F\u0440\u043E\u0442\u0435\u043E\u043C\u0438\u043A\u0430",
      "\u0442\u043E\u043F\u043E\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u0433\u043E\u043C\u043E\u043C\u043E\u0440\u0444\u043D\u044B\u0439",
      "\u0441 \u043D\u0443\u043B\u0435\u0432\u044B\u043C \u0440\u0430\u0437\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435\u043C",
      "\u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0435 \u0440\u0435\u0448\u0451\u0442\u043E\u043A",
      // German
      "quanten",
      "photonik",
      "genomik",
      "proteomik",
      "topologisch",
      "homomorph",
      "zero-knowledge",
      "gitterbasiert",
      // Spanish
      "cu\xE1ntico",
      "fot\xF3nica",
      "gen\xF3mica",
      "prote\xF3mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Portuguese
      "qu\xE2ntico",
      "fot\xF4nica",
      "gen\xF4mica",
      "prote\xF4mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Korean
      "\uC591\uC790",
      "\uD3EC\uD1A0\uB2C9\uC2A4",
      "\uC720\uC804\uCCB4\uD559",
      "\uC704\uC0C1",
      "\uB3D9\uD615",
      // Arabic
      "\u0643\u0645\u064A",
      "\u0636\u0648\u0626\u064A\u0627\u062A",
      "\u062C\u064A\u0646\u0648\u0645\u064A\u0627\u062A",
      "\u0637\u0648\u0628\u0648\u0644\u0648\u062C\u064A",
      "\u062A\u0645\u0627\u062B\u0644\u064A"
    ],
    // Agentic task keywords - file ops, execution, multi-step, iterative work
    // Pruned: removed overly common words like "then", "first", "run", "test", "build"
    agenticTaskKeywords: [
      // English - File operations (clearly agentic)
      "read file",
      "read the file",
      "look at",
      "check the",
      "open the",
      "edit",
      "modify",
      "update the",
      "change the",
      "write to",
      "create file",
      // English - Execution (specific commands only)
      "execute",
      "deploy",
      "install",
      "npm",
      "pip",
      "compile",
      // English - Multi-step patterns (specific only)
      "after that",
      "and also",
      "once done",
      "step 1",
      "step 2",
      // English - Iterative work
      "fix",
      "debug",
      "until it works",
      "keep trying",
      "iterate",
      "make sure",
      "verify",
      "confirm",
      // Chinese (keep specific ones)
      "\u8BFB\u53D6\u6587\u4EF6",
      "\u67E5\u770B",
      "\u6253\u5F00",
      "\u7F16\u8F91",
      "\u4FEE\u6539",
      "\u66F4\u65B0",
      "\u521B\u5EFA",
      "\u6267\u884C",
      "\u90E8\u7F72",
      "\u5B89\u88C5",
      "\u7B2C\u4E00\u6B65",
      "\u7B2C\u4E8C\u6B65",
      "\u4FEE\u590D",
      "\u8C03\u8BD5",
      "\u76F4\u5230",
      "\u786E\u8BA4",
      "\u9A8C\u8BC1",
      // Spanish
      "leer archivo",
      "editar",
      "modificar",
      "actualizar",
      "ejecutar",
      "desplegar",
      "instalar",
      "paso 1",
      "paso 2",
      "arreglar",
      "depurar",
      "verificar",
      // Portuguese
      "ler arquivo",
      "editar",
      "modificar",
      "atualizar",
      "executar",
      "implantar",
      "instalar",
      "passo 1",
      "passo 2",
      "corrigir",
      "depurar",
      "verificar",
      // Korean
      "\uD30C\uC77C \uC77D\uAE30",
      "\uD3B8\uC9D1",
      "\uC218\uC815",
      "\uC5C5\uB370\uC774\uD2B8",
      "\uC2E4\uD589",
      "\uBC30\uD3EC",
      "\uC124\uCE58",
      "\uB2E8\uACC4 1",
      "\uB2E8\uACC4 2",
      "\uB514\uBC84\uADF8",
      "\uD655\uC778",
      // Arabic
      "\u0642\u0631\u0627\u0621\u0629 \u0645\u0644\u0641",
      "\u062A\u062D\u0631\u064A\u0631",
      "\u062A\u0639\u062F\u064A\u0644",
      "\u062A\u062D\u062F\u064A\u062B",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u0646\u0634\u0631",
      "\u062A\u062B\u0628\u064A\u062A",
      "\u0627\u0644\u062E\u0637\u0648\u0629 1",
      "\u0627\u0644\u062E\u0637\u0648\u0629 2",
      "\u0625\u0635\u0644\u0627\u062D",
      "\u062A\u0635\u062D\u064A\u062D",
      "\u062A\u062D\u0642\u0642"
    ],
    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02,
      // Reduced from 0.12 to make room for agenticTask
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04
      // Reduced - agentic signals influence tier selection, not dominate it
    },
    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0,
      mediumComplex: 0.3,
      // Raised from 0.18 - prevent simple tasks from reaching expensive COMPLEX tier
      complexReasoning: 0.5
      // Raised from 0.4 - reserve for true reasoning tasks
    },
    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.7
  },
  // ─── Tier chains ───
  //
  // Catalog refresh 2026-08-29 (V3.5). Every chain below names only models
  // the public catalog lists (GET https://blockrun.ai/api/v1/models). Ids the
  // gateway withholds (`hidden: true`) — kimi-k2.5/k2.6/k2.7, the grok-4-fast
  // and grok-4-1-fast pairs, grok-4-0709, claude-opus-4.6, gemini-3-pro-preview,
  // the whole `free/*` namespace — were removed everywhere, including fallback
  // rungs, so a routed model is always one a user can find on blockrun.ai/models.
  //
  // Primaries moved only where portfolio.ts already carries calibration
  // evidence for the successor (Sonnet 5 over Sonnet 4.6, GPT-5 Mini for
  // agentic MEDIUM, Gemini 3.5 Flash where Kimi K2.7 was). Newcomers with no
  // trajectory evidence yet (gemini-3.6-flash, glm-5.3, glm-5.3-flash,
  // gpt-5.6-luna, grok-4.3, minimax-m3, qwen3.7-plus) enter as fallback rungs;
  // promotion waits for a calibration run, because version recency is not a
  // quality signal.
  //
  // Latency figures in comments are the 2026-08-29 gateway probe
  // (model-profiles.generated.json); prices are the catalog list.
  // Auto (balanced) tier configs - current default smart routing
  tiers: {
    SIMPLE: {
      primary: "google/gemini-2.5-flash",
      // $0.30/$2.50 — 60% retention (best) in the 2026-03 run; still the fastest quality answer
      fallback: [
        "google/gemini-3-flash-preview",
        // $0.50/$3 — GPQA 5/6 in the 2026-07 calibration
        "google/gemini-3.5-flash-lite",
        // $0.30/$2.50, 1M ctx, thinking mode — same price as 2.5 Flash, newer generation
        "deepseek/deepseek-chat",
        // $0.14/$0.28, 1M ctx
        "google/gemini-3.1-flash-lite",
        // $0.25/$1.50, 1M ctx
        "openai/gpt-5.6-luna",
        // $0.20/$1.20, 1M ctx — GPT-5.6 cost tier (cut 2026-07-30)
        "openai/gpt-5.4-nano",
        // $0.20/$1.25, 1M ctx
        "google/gemini-2.5-flash-lite",
        // $0.10/$0.40
        "nvidia/nemotron-3.5-lightning"
        // FREE backstop — NVIDIA free tier (probed 2026-08-30)
      ]
    },
    MEDIUM: {
      // Was moonshot/kimi-k2.7 (hidden 2026-08). Gemini 3.5 Flash is the
      // calibrated successor: MGSM 5/5, GPQA 4/6, extraction band (portfolio.ts).
      primary: "google/gemini-3.5-flash",
      // $1.50/$9, 1M ctx, vision + tools
      fallback: [
        "google/gemini-3.6-flash",
        // $1.50/$7.50 — newest Flash, output 17% cheaper than 3.5; awaiting calibration
        "zai/glm-5.3-flash",
        // $0.15/$0.50, 1M ctx, vision + tools verified live 2026-08-27
        "openai/gpt-5.6-terra",
        // $2/$12, 1M ctx — GPT-5.6 balanced tier
        "google/gemini-3-flash-preview",
        // $0.50/$3
        "deepseek/deepseek-chat",
        // $0.14/$0.28
        "google/gemini-2.5-flash",
        // $0.30/$2.50
        "minimax/minimax-m3",
        // $0.30/$1.20, 1M ctx
        "google/gemini-3.1-flash-lite",
        // $0.25/$1.50
        "openai/gpt-5.6-luna",
        // $0.20/$1.20
        "google/gemini-2.5-flash-lite"
        // $0.10/$0.40
      ]
    },
    COMPLEX: {
      primary: "google/gemini-3.1-pro",
      // $2/$12 — proven long-context flagship (portfolio.ts long_context lead)
      fallback: [
        "google/gemini-3.6-flash",
        // $1.50/$7.50 — Pro-level quality at Flash price (Google's claim; uncalibrated here)
        "google/gemini-3.5-flash",
        // $1.50/$9 — calibrated
        "anthropic/claude-sonnet-5",
        // $3/$15 — near-Opus quality, tau2 + Terminal-Bench calibrated
        "xai/grok-4.5",
        // $2.50/$9 — 503-resistant, independent infra (was grok-4-0709, now hidden)
        "google/gemini-2.5-pro",
        // $1.25/$10
        "anthropic/claude-sonnet-4.6",
        // $3/$15
        "openai/gpt-5.6-terra",
        // $2/$12 — GPT-5.6 balanced tier (Sol excluded: #202)
        "openai/gpt-5.5",
        // $5/$30 — prior OpenAI flagship
        "openai/gpt-5.4",
        // $2.50/$15 — previous flagship, benchmarked
        "zai/glm-5.3",
        // $1.40/$4.40, 1M ctx, always-on thinking — verified live 2026-08-19
        "moonshot/kimi-k3",
        // $3/$15, 1M ctx — Moonshot flagship (K2.7 successor)
        "deepseek/deepseek-v4-pro",
        // $0.435/$0.87 — strongest open-weight reasoner
        "deepseek/deepseek-chat",
        // $0.14/$0.28 — cheap last resort
        "google/gemini-2.5-flash"
        // $0.30/$2.50
      ]
    },
    REASONING: {
      // Was xai/grok-4-1-fast-reasoning ($0.20/$0.50, hidden 2026-08). DeepSeek
      // Reasoner is the cheapest listed reasoner at the same 1M context.
      primary: "deepseek/deepseek-reasoner",
      // $0.14/$0.28, 1M ctx
      fallback: [
        "deepseek/deepseek-v4-pro",
        // $0.435/$0.87 — calibrated reasoning band 0.95
        "xai/grok-4.3",
        // $1.50/$4, 1M ctx — xAI reasoning model, vision
        "qwen/qwen3.7-plus",
        // $0.32/$1.28, 1M ctx — reasoning; needs a generous max_tokens (thinking is billed)
        "google/gemini-3.5-flash",
        // $1.50/$9 — MGSM 5/5
        "openai/o4-mini",
        // $1.10/$4.40
        "openai/o3"
        // $2/$8
      ]
    }
  },
  // Eco tier configs - absolute cheapest (blockrun/eco)
  ecoTiers: {
    SIMPLE: {
      primary: "nvidia/nemotron-3.5-lightning",
      // FREE — NVIDIA free tier flagship, 1M ctx
      fallback: [
        "nvidia/nemotron-3-nano-30b",
        // FREE — fastest free model (~121 tok/s)
        // The free head keeps rotting with NVIDIA's hosting (deepseek-v4-flash
        // 410 2026-08-12, seed-oss-36b 410 2026-08-03, gpt-oss-120b/20b 400
        // 2026-08-21, and on 2026-08-30 FOUR of the five visible free models at
        // once — step-3.7-flash, nemotron-nano-9b-v2 and nemotron-nano-12b-v2-vl
        // all 410, mistral-nemotron hung). Each retirement retargets the two
        // free rungs to the current free tier; the paid rungs below never move.
        // The head follows blockrun's own redirect of the model it replaces, so
        // the router and the gateway never name different models.
        "google/gemini-2.5-flash-lite",
        // $0.10/$0.40 — cheapest paid rung
        "zai/glm-5.3-flash",
        // $0.15/$0.50, 1M ctx, vision + tools
        "openai/gpt-5.6-luna",
        // $0.20/$1.20, 1M ctx
        "openai/gpt-5.4-nano",
        // $0.20/$1.25
        "google/gemini-3.1-flash-lite"
        // $0.25/$1.50
      ]
    },
    MEDIUM: {
      primary: "zai/glm-5.3-flash",
      // $0.15/$0.50, 1M ctx, vision + tools verified live — cheapest full-capability model
      fallback: [
        "deepseek/deepseek-chat",
        // $0.14/$0.28
        "google/gemini-3.1-flash-lite",
        // $0.25/$1.50
        "openai/gpt-5.6-luna",
        // $0.20/$1.20
        "openai/gpt-5.4-nano",
        // $0.20/$1.25
        "google/gemini-2.5-flash-lite",
        // $0.10/$0.40
        "google/gemini-2.5-flash"
        // $0.30/$2.50
      ]
    },
    COMPLEX: {
      primary: "zai/glm-5.3-flash",
      // $0.15/$0.50, 1M ctx
      fallback: [
        "deepseek/deepseek-chat",
        // $0.14/$0.28, 1M ctx
        "minimax/minimax-m3",
        // $0.30/$1.20, 1M ctx
        "deepseek/deepseek-v4-pro",
        // $0.435/$0.87
        "google/gemini-3.1-flash-lite",
        // $0.25/$1.50
        "google/gemini-2.5-flash"
        // $0.30/$2.50
      ]
    },
    REASONING: {
      primary: "deepseek/deepseek-reasoner",
      // $0.14/$0.28, 1M ctx — cheapest listed reasoner
      fallback: [
        "deepseek/deepseek-v4-pro",
        // $0.435/$0.87
        "qwen/qwen3.7-plus",
        // $0.32/$1.28 — reasoning
        "minimax/minimax-m3",
        // $0.30/$1.20 — reasoning + coding
        "zai/glm-5.3-flash"
        // $0.15/$0.50 — reasoning tokens alongside content
      ]
    }
  },
  // Premium tier configs - best quality (blockrun/premium)
  // codex=complex coding, flash=simple coding, sonnet=reasoning/instructions, fable/opus=architecture/PM/audits
  premiumTiers: {
    SIMPLE: {
      // Was moonshot/kimi-k2.7 (hidden 2026-08).
      primary: "google/gemini-3.5-flash",
      // $1.50/$9, 1M ctx, vision + tools — calibrated
      fallback: [
        "google/gemini-3.6-flash",
        // $1.50/$7.50 — newest Flash
        "anthropic/claude-haiku-4.5",
        // $1/$5
        "zai/glm-5.3",
        // $1.40/$4.40, 1M ctx
        "google/gemini-2.5-flash",
        // $0.30/$2.50
        "google/gemini-3.5-flash-lite",
        // $0.30/$2.50
        "deepseek/deepseek-chat"
        // $0.14/$0.28
      ]
    },
    MEDIUM: {
      primary: "openai/gpt-5.3-codex",
      // $1.75/$14 - 400K context, 128K output — code_edit/debug lead (portfolio.ts)
      fallback: [
        "anthropic/claude-sonnet-5",
        // $3/$15 — code_agent band 0.98
        "moonshot/kimi-k3",
        // $3/$15, 1M ctx — Moonshot flagship
        "zai/glm-5.3",
        // $1.40/$4.40 — long-horizon coding
        "google/gemini-3.6-flash",
        // $1.50/$7.50
        "google/gemini-3.5-flash",
        // $1.50/$9
        "google/gemini-2.5-pro",
        // $1.25/$10
        "xai/grok-4.5",
        // $2.50/$9
        "anthropic/claude-sonnet-4.6",
        // $3/$15
        "openai/gpt-5.6-terra"
        // $2/$12
      ]
    },
    COMPLEX: {
      // fable-5 was promoted here 2026-06-11, force-reverted 2026-06-13 when Anthropic
      // withdrew the offer, and restored 2026-07-14 now that BlockRun has relisted it.
      primary: "anthropic/claude-fable-5",
      // Best quality for complex tasks — Mythos-class flagship above Opus ($10/$50, 1M ctx, always-on thinking)
      // Fallback chain de-Gemini'd 2026-04-22: when Anthropic 503s, Gemini is
      // also prone to "high demand" 503s (correlated failure — everyone falls
      // back to Google at the same time). Prefer in-family → xAI → Moonshot →
      // OpenAI flagship → Z.AI → DeepSeek → NVIDIA free instead.
      fallback: [
        "anthropic/claude-opus-5",
        // in-family hot swap first (half the price, 1M ctx + adaptive thinking)
        "anthropic/claude-opus-4.8",
        // in-family hot swap (identical cost to 5)
        "anthropic/claude-opus-4.7",
        // in-family hot swap (identical cost to 4.8)
        "anthropic/claude-sonnet-5",
        // Sonnet-tier drop-down, near-Opus quality
        "anthropic/claude-sonnet-4.6",
        "xai/grok-4.5",
        // xAI flagship — 503-resistant, direct-xAI SKU
        "moonshot/kimi-k3",
        // Moonshot flagship, independent infra
        "openai/gpt-5.6-terra",
        // GPT-5.6 balanced tier — stable (Sol excluded: #202)
        "openai/gpt-5.5",
        // Prior OpenAI flagship — 1M+ ctx, native agent + computer use
        "openai/gpt-5.4",
        // Previous flagship (slow but stable, benchmarked at 6,213ms)
        "openai/gpt-5.3-codex",
        "zai/glm-5.3",
        // Z.AI flagship, 1M ctx
        "deepseek/deepseek-v4-pro",
        // strongest open-weight reasoner
        "deepseek/deepseek-chat",
        // Cheap, reliable
        "nvidia/nemotron-3.5-lightning"
        // NVIDIA free ultimate backstop
      ]
    },
    REASONING: {
      // Sonnet 5 promoted over Sonnet 4.6 (same price; reasoning band 0.98 for both,
      // plus Sonnet 5's tau2/BrowseComp trajectory evidence).
      primary: "anthropic/claude-sonnet-5",
      // $3/$15, 1M ctx, adaptive thinking
      fallback: [
        "anthropic/claude-sonnet-4.6",
        // in-family hot swap — same cost
        "anthropic/claude-opus-5",
        // Newest flagship Opus w/ adaptive thinking
        "anthropic/claude-opus-4.8",
        // Prior flagship Opus — identical cost to 5
        "anthropic/claude-opus-4.7",
        // Flagship Opus w/ adaptive thinking
        "xai/grok-4.5",
        // reasoning band 0.94
        "deepseek/deepseek-v4-pro",
        // reasoning band 0.95
        "xai/grok-4.3",
        // $1.50/$4 — xAI reasoning model
        "openai/o4-mini",
        // $1.10/$4.40
        "openai/o3"
        // $2/$8
      ]
    }
  },
  // Agentic tier configs - models that excel at multi-step autonomous tasks
  agenticTiers: {
    SIMPLE: {
      primary: "openai/gpt-4o-mini",
      // $0.15/$0.60 - best tool compliance at lowest cost
      fallback: [
        "openai/gpt-5.6-luna",
        // $0.20/$1.20 — lightweight agentic tier of GPT-5.6
        "zai/glm-5.3-flash",
        // $0.15/$0.50 — tool calls verified live 2026-08-27
        "anthropic/claude-haiku-4.5",
        // $1/$5
        "google/gemini-2.5-flash"
        // $0.30/$2.50
      ]
    },
    MEDIUM: {
      // Was moonshot/kimi-k2.7 (hidden 2026-08). GPT-5 Mini carries the
      // Terminal-Bench and tau2 trajectory evidence in portfolio.ts.
      primary: "openai/gpt-5-mini",
      // $0.25/$2 — 4/7 Terminal-Bench, 5/6 tau2 airline
      fallback: [
        "google/gemini-3.5-flash",
        // $1.50/$9 — tool_agent band 0.88
        "zai/glm-5.3-flash",
        // $0.15/$0.50 — tools verified
        "openai/gpt-5.6-terra",
        // $2/$12
        "openai/gpt-4o-mini",
        // $0.15/$0.60 — reliable tool calling
        "anthropic/claude-haiku-4.5",
        // $1/$5
        "deepseek/deepseek-chat",
        // $0.14/$0.28
        "moonshot/kimi-k3"
        // $3/$15 — tool_agent band 0.85
      ]
    },
    COMPLEX: {
      // Sonnet 5 promoted over Sonnet 4.6: tau2 airline + retail reward 1.0,
      // Terminal-Bench safety band lead (portfolio.ts).
      primary: "anthropic/claude-sonnet-5",
      // $3/$15 — best agentic quality per trajectory evidence
      // Fallback chain de-Gemini'd 2026-04-22: Gemini's "high demand" 503s
      // correlate with Anthropic outages (everyone falls back together).
      // Prefer 503-resistant providers first.
      fallback: [
        "anthropic/claude-sonnet-4.6",
        // in-family hot swap — same cost
        "anthropic/claude-opus-5",
        // Newest flagship Opus — in-family hot swap
        "anthropic/claude-opus-4.8",
        // Prior flagship Opus — identical cost to 5
        "anthropic/claude-opus-4.7",
        // Flagship Opus — in-family hot swap
        "xai/grok-4.5",
        // xAI flagship — strong tool use, independent infra
        "moonshot/kimi-k3",
        // Moonshot flagship — independent infra
        "openai/gpt-5.6-terra",
        // GPT-5.6 balanced tier — stable (Sol excluded: #202)
        "openai/gpt-5.5",
        // Prior flagship — native agent + computer use (exactly the agentic-tier use case)
        "openai/gpt-5.4",
        // Previous flagship — reliable
        "openai/gpt-5.3-codex",
        // code_agent lead
        "zai/glm-5.3",
        // long-horizon coding
        "deepseek/deepseek-v4-pro",
        // retail high-risk 3/3
        "deepseek/deepseek-chat",
        // cheap, reliable
        "nvidia/nemotron-3.5-lightning"
        // NVIDIA free ultimate backstop
      ]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-5",
      // $3/$15 — strong tool use + adaptive thinking
      fallback: [
        "anthropic/claude-sonnet-4.6",
        // in-family hot swap — same cost
        "anthropic/claude-opus-5",
        // Newest flagship Opus w/ adaptive thinking
        "anthropic/claude-opus-4.8",
        // Prior flagship Opus — identical cost to 5
        "anthropic/claude-opus-4.7",
        // Flagship Opus w/ adaptive thinking
        "xai/grok-4.5",
        // reasoning band 0.94
        "deepseek/deepseek-v4-pro",
        // reasoning band 0.95
        "deepseek/deepseek-reasoner"
        // $0.14/$0.28
      ]
    }
  },
  // Time-windowed promotions — auto-applied when active, ignored when expired.
  // The GLM-5.1 launch promo (2026-04-01 → 2026-05-01) was the last entry and
  // has expired; the list is kept empty so the mechanism stays wired.
  promotions: [],
  overrides: {
    maxTokensForceComplex: 1e5,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM"
    // agenticMode left undefined → auto-detect via tools/agenticScore.
    // Set to `true` to force agentic tiers; `false` to disable them entirely.
  }
};
registerStrategy(new PortfolioStrategy());
function route(prompt, systemPrompt, maxOutputTokens, options) {
  const strategy = getStrategy(options.config.strategy ?? "portfolio");
  return strategy.route(prompt, systemPrompt, maxOutputTokens, options);
}
export {
  DEFAULT_MODEL_CAPABILITIES,
  DEFAULT_ROUTING_CONFIG,
  HISTORICAL_MODEL_PROFILES,
  LIVE_MODEL_PROFILES,
  PortfolioStrategy,
  RulesStrategy,
  applyUnavailableModels,
  calculateModelCost,
  classifyByRules,
  filterByExcludeList,
  filterByToolCalling,
  filterByVision,
  filterCandidatesByCapacity,
  getFallbackChain,
  getFallbackChainFiltered,
  getStrategy,
  inferToolRequirement,
  registerStrategy,
  route
};
//# sourceMappingURL=index.js.map