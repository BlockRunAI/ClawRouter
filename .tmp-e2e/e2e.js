// src/router/rules.ts
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
function classifyByRules(prompt, systemPrompt, estimatedTokens, config2) {
  const text = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  const userText = prompt.toLowerCase();
  const dimensions = [
    // Original 8 dimensions
    scoreTokenCount(estimatedTokens, config2.tokenCountThresholds),
    scoreKeywordMatch(
      text,
      config2.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1 }
    ),
    // Reasoning markers use USER prompt only — system prompt "step by step" shouldn't trigger reasoning
    scoreKeywordMatch(
      userText,
      config2.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1 }
    ),
    scoreKeywordMatch(
      text,
      config2.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      text,
      config2.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config2.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1, high: -1 }
    ),
    scoreMultiStep(text),
    scoreQuestionComplexity(prompt),
    // 6 new dimensions
    scoreKeywordMatch(
      text,
      config2.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config2.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config2.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config2.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config2.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config2.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 }
    )
  ];
  const agenticResult = scoreAgenticTask(text, config2.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weights = config2.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }
  const reasoningMatches = config2.reasoningKeywords.filter(
    (kw) => userText.includes(kw.toLowerCase())
  );
  if (reasoningMatches.length >= 2) {
    const confidence2 = calibrateConfidence(
      Math.max(weightedScore, 0.3),
      // ensure positive for confidence calc
      config2.confidenceSteepness
    );
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence2, 0.85),
      signals,
      agenticScore
    };
  }
  const { simpleMedium, mediumComplex, complexReasoning } = config2.tierBoundaries;
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
  const confidence = calibrateConfidence(distanceFromBoundary, config2.confidenceSteepness);
  if (confidence < config2.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore };
}
function calibrateConfidence(distance, steepness) {
  return 1 / (1 + Math.exp(-steepness * distance));
}

// src/router/selector.ts
function selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing2, estimatedInputTokens, maxOutputTokens, routingProfile) {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing2.get(model);
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = estimatedInputTokens / 1e6 * inputPrice;
  const outputCost = maxOutputTokens / 1e6 * outputPrice;
  const costEstimate = inputCost + outputCost;
  const opusPricing = modelPricing2.get("anthropic/claude-opus-4.5");
  const opusInputPrice = opusPricing?.inputPrice ?? 0;
  const opusOutputPrice = opusPricing?.outputPrice ?? 0;
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
    savings
  };
}
function getFallbackChain(tier, tierConfigs) {
  const config2 = tierConfigs[tier];
  return [config2.primary, ...config2.fallback];
}
function calculateModelCost(model, modelPricing2, estimatedInputTokens, maxOutputTokens, routingProfile) {
  const pricing = modelPricing2.get(model);
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = estimatedInputTokens / 1e6 * inputPrice;
  const outputCost = maxOutputTokens / 1e6 * outputPrice;
  const costEstimate = inputCost + outputCost;
  const opusPricing = modelPricing2.get("anthropic/claude-opus-4.5");
  const opusInputPrice = opusPricing?.inputPrice ?? 0;
  const opusOutputPrice = opusPricing?.outputPrice ?? 0;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return { costEstimate, baselineCost, savings };
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

// src/router/config.ts
var DEFAULT_ROUTING_CONFIG = {
  version: "2.0",
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
    // Multilingual keywords: English + Chinese (中文) + Japanese (日本語) + Russian (Русский) + German (Deutsch)
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
      "zur\xFCckgeben"
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
      "logisch"
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
      "erkl\xE4re"
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
      "infrastruktur"
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
      "erz\xE4hlung"
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
      "einrichten"
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
      "budget"
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
      "strukturiert"
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
      "anhang"
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
      "nicht mehr"
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
      "gitterbasiert"
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
      "\u9A8C\u8BC1"
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
  // Auto (balanced) tier configs - current default smart routing
  tiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // $0.50/$2.40 - best quality/price for simple tasks
      fallback: [
        "google/gemini-2.5-flash",
        // 1M context, cost-effective
        "nvidia/gpt-oss-120b",
        // FREE fallback
        "deepseek/deepseek-chat"
      ]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      // Code specialist, $0.20/$1.50
      fallback: [
        "google/gemini-2.5-flash",
        // 1M context, cost-effective
        "deepseek/deepseek-chat",
        "xai/grok-4-1-fast-non-reasoning"
        // Upgraded Grok 4.1
      ]
    },
    COMPLEX: {
      primary: "google/gemini-3-pro-preview",
      // Latest Gemini - upgraded from 2.5
      fallback: [
        "google/gemini-2.5-flash",
        // CRITICAL: 1M context, cheap failsafe before expensive models
        "google/gemini-2.5-pro",
        "deepseek/deepseek-chat",
        // Another cheap option
        "xai/grok-4-0709",
        "openai/gpt-5.2",
        // Newer and cheaper input than gpt-4o
        "openai/gpt-4o",
        "anthropic/claude-sonnet-4.6"
      ]
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning",
      // Upgraded Grok 4.1 reasoning $0.20/$0.50
      fallback: [
        "deepseek/deepseek-reasoner",
        // Cheap reasoning model as first fallback
        "openai/o4-mini",
        // Newer and cheaper than o3 ($1.10 vs $2.00)
        "openai/o3"
      ]
    }
  },
  // Eco tier configs - ultra cost-optimized (blockrun/eco)
  ecoTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // $0.50/$2.40
      fallback: ["nvidia/gpt-oss-120b", "deepseek/deepseek-chat", "google/gemini-2.5-flash"]
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat",
      // $0.14/$0.28
      fallback: ["xai/grok-code-fast-1", "google/gemini-2.5-flash", "moonshot/kimi-k2.5"]
    },
    COMPLEX: {
      primary: "xai/grok-4-0709",
      // $0.20/$1.50
      fallback: ["deepseek/deepseek-chat", "google/gemini-2.5-flash", "openai/gpt-4o-mini"]
    },
    REASONING: {
      primary: "deepseek/deepseek-reasoner",
      // $0.55/$2.19
      fallback: ["xai/grok-4-1-fast-reasoning"]
    }
  },
  // Premium tier configs - best quality (blockrun/premium)
  // codex=complex coding, kimi=simple coding, sonnet=reasoning/instructions, opus=architecture/PM/audits
  premiumTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // $0.50/$2.40 - good for simple coding
      fallback: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash", "xai/grok-code-fast-1"]
    },
    MEDIUM: {
      primary: "openai/gpt-5.2-codex",
      // $2.50/$10 - strong coding for medium tasks
      fallback: [
        "moonshot/kimi-k2.5",
        "google/gemini-2.5-pro",
        "xai/grok-4-0709",
        "anthropic/claude-sonnet-4.6"
      ]
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4.6",
      // Best quality for complex tasks
      fallback: [
        "openai/gpt-5.2-codex",
        "anthropic/claude-opus-4.5",
        "anthropic/claude-sonnet-4.6",
        "google/gemini-3-pro-preview",
        "moonshot/kimi-k2.5"
      ]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6",
      // $3/$15 - best for reasoning/instructions
      fallback: [
        "anthropic/claude-opus-4.6",
        "anthropic/claude-opus-4.5",
        "openai/o4-mini",
        // Newer and cheaper than o3 ($1.10 vs $2.00)
        "openai/o3",
        "xai/grok-4-1-fast-reasoning"
      ]
    }
  },
  // Agentic tier configs - models that excel at multi-step autonomous tasks
  agenticTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // Cheaper than Haiku ($0.5/$2.4 vs $1/$5), larger context
      fallback: [
        "anthropic/claude-haiku-4.5",
        "xai/grok-4-1-fast-non-reasoning",
        "openai/gpt-4o-mini"
      ]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      // Code specialist for agentic coding
      fallback: ["moonshot/kimi-k2.5", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.6"]
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4.6",
      fallback: [
        "anthropic/claude-opus-4.6",
        // Latest Opus - best agentic
        "openai/gpt-5.2",
        "google/gemini-3-pro-preview",
        "xai/grok-4-0709"
      ]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6",
      // Strong tool use + reasoning for agentic tasks
      fallback: [
        "anthropic/claude-opus-4.6",
        "xai/grok-4-1-fast-reasoning",
        "deepseek/deepseek-reasoner"
      ]
    }
  },
  overrides: {
    maxTokensForceComplex: 1e5,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM",
    agenticMode: false
  }
};

// src/router/index.ts
function route(prompt, systemPrompt, maxOutputTokens, options) {
  const { config: config2, modelPricing: modelPricing2 } = options;
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config2.scoring);
  const { routingProfile } = options;
  let tierConfigs;
  let profileSuffix = "";
  if (routingProfile === "eco" && config2.ecoTiers) {
    tierConfigs = config2.ecoTiers;
    profileSuffix = " | eco";
  } else if (routingProfile === "premium" && config2.premiumTiers) {
    tierConfigs = config2.premiumTiers;
    profileSuffix = " | premium";
  } else {
    const agenticScore = ruleResult.agenticScore ?? 0;
    const isAutoAgentic = agenticScore >= 0.5;
    const isExplicitAgentic = config2.overrides.agenticMode ?? false;
    const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config2.agenticTiers != null;
    tierConfigs = useAgenticTiers ? config2.agenticTiers : config2.tiers;
    profileSuffix = useAgenticTiers ? " | agentic" : "";
  }
  if (estimatedTokens > config2.overrides.maxTokensForceComplex) {
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config2.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
      tierConfigs,
      modelPricing2,
      estimatedTokens,
      maxOutputTokens,
      routingProfile
    );
  }
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
  let tier;
  let confidence;
  const method = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;
  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    tier = config2.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }
  if (hasStructuredOutput) {
    const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config2.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }
  reasoning += profileSuffix;
  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing2,
    estimatedTokens,
    maxOutputTokens,
    routingProfile
  );
}

// src/models.ts
var MODEL_ALIASES = {
  // Claude - short names
  claude: "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.6",
  // Updated to latest Opus 4.6
  "opus-46": "anthropic/claude-opus-4.6",
  "opus-45": "anthropic/claude-opus-4.5",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  "anthropic/opus": "anthropic/claude-opus-4.6",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.2",
  codex: "openai/gpt-5.2-codex",
  mini: "openai/gpt-4o-mini",
  o3: "openai/o3",
  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",
  // Kimi / Moonshot
  kimi: "moonshot/kimi-k2.5",
  // Google
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  // xAI
  grok: "xai/grok-3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-code": "xai/grok-code-fast-1",
  // NVIDIA
  nvidia: "nvidia/gpt-oss-120b",
  "gpt-120b": "nvidia/gpt-oss-120b"
  // Note: auto, free, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs
};
function resolveModelAlias(model) {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved) return resolved;
  if (normalized.startsWith("blockrun/")) {
    const withoutPrefix = normalized.slice("blockrun/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;
    return withoutPrefix;
  }
  return model;
}
var BLOCKRUN_MODELS = [
  // Smart routing meta-models — proxy replaces with actual model
  // NOTE: Model IDs are WITHOUT provider prefix (OpenClaw adds "blockrun/" automatically)
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 105e4,
    maxOutput: 128e3
  },
  {
    id: "free",
    name: "Free (NVIDIA GPT-OSS-120B only)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128e3,
    maxOutput: 4096
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 105e4,
    maxOutput: 128e3
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 2e6,
    maxOutput: 2e5
  },
  // OpenAI GPT-5 Family
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    inputPrice: 1.75,
    outputPrice: 14,
    contextWindow: 4e5,
    maxOutput: 128e3,
    reasoning: true,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    inputPrice: 0.25,
    outputPrice: 2,
    contextWindow: 2e5,
    maxOutput: 65536
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128e3,
    maxOutput: 32768
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    inputPrice: 21,
    outputPrice: 168,
    contextWindow: 4e5,
    maxOutput: 128e3,
    reasoning: true
  },
  // OpenAI Codex Family
  {
    id: "openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    inputPrice: 2.5,
    outputPrice: 12,
    contextWindow: 128e3,
    maxOutput: 32e3,
    agentic: true
  },
  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 128e3,
    maxOutput: 16384,
    vision: true
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  // gpt-4.1-nano removed - replaced by gpt-5-nano
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.5,
    outputPrice: 10,
    contextWindow: 128e3,
    maxOutput: 16384,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  // OpenAI O-series (Reasoning) - o1/o1-mini removed, replaced by o3/o4
  {
    id: "openai/o3",
    name: "o3",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 2e5,
    maxOutput: 1e5,
    reasoning: true
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128e3,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128e3,
    maxOutput: 65536,
    reasoning: true
  },
  // Anthropic - all Claude models excel at agentic workflows
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    inputPrice: 1,
    outputPrice: 5,
    contextWindow: 2e5,
    maxOutput: 8192,
    agentic: true
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 2e5,
    maxOutput: 64e3,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15,
    outputPrice: 75,
    contextWindow: 2e5,
    maxOutput: 32e3,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    inputPrice: 5,
    outputPrice: 25,
    contextWindow: 2e5,
    maxOutput: 32e3,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    inputPrice: 5,
    outputPrice: 25,
    contextWindow: 2e5,
    maxOutput: 64e3,
    reasoning: true,
    vision: true,
    agentic: true
  },
  // Google
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    inputPrice: 2,
    outputPrice: 12,
    contextWindow: 105e4,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputPrice: 1.25,
    outputPrice: 10,
    contextWindow: 105e4,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 1e6,
    maxOutput: 65536
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128e3,
    maxOutput: 8192
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128e3,
    maxOutput: 8192,
    reasoning: true
  },
  // Moonshot / Kimi - optimized for agentic workflows
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    inputPrice: 0.5,
    outputPrice: 2.4,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true
  },
  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    agentic: true
    // Good for coding tasks
  },
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  // grok-2-vision removed - old, 0 transactions
  // NVIDIA - Free/cheap models
  {
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    inputPrice: 0.55,
    outputPrice: 2.5,
    contextWindow: 262144,
    maxOutput: 16384
  }
];
function toOpenClawModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput
  };
}
var ALIAS_MODELS = Object.entries(MODEL_ALIASES).map(([alias, targetId]) => {
  const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
  if (!target) return null;
  return toOpenClawModel({ ...target, id: alias, name: `${alias} \u2192 ${target.name}` });
}).filter((m) => m !== null);
var OPENCLAW_MODELS = [
  ...BLOCKRUN_MODELS.map(toOpenClawModel),
  ...ALIAS_MODELS
];
function getModelContextWindow(modelId) {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.contextWindow;
}
function isReasoningModel(modelId) {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.reasoning ?? false;
}

// src/proxy.ts
import { createServer } from "http";
import { finished } from "stream";
import { privateKeyToAccount as privateKeyToAccount2 } from "viem/accounts";

// src/x402.ts
import { signTypedData, privateKeyToAccount } from "viem/accounts";

// src/payment-cache.ts
var DEFAULT_TTL_MS = 36e5;
var PaymentCache = class {
  cache = /* @__PURE__ */ new Map();
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  /** Get cached payment params for an endpoint path. */
  get(endpointPath) {
    const entry = this.cache.get(endpointPath);
    if (!entry) return void 0;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(endpointPath);
      return void 0;
    }
    return entry;
  }
  /** Cache payment params from a 402 response. */
  set(endpointPath, params) {
    this.cache.set(endpointPath, { ...params, cachedAt: Date.now() });
  }
  /** Invalidate cache for an endpoint (e.g., if payTo changed). */
  invalidate(endpointPath) {
    this.cache.delete(endpointPath);
  }
};

// src/x402.ts
var BASE_CHAIN_ID = 8453;
var BASE_SEPOLIA_CHAIN_ID = 84532;
var DEFAULT_TOKEN_NAME = "USD Coin";
var DEFAULT_TOKEN_VERSION = "2";
var DEFAULT_NETWORK = "eip155:8453";
var DEFAULT_MAX_TIMEOUT_SECONDS = 300;
var TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};
function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function decodeBase64Json(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - normalized.length % 4) % 4;
  const padded = normalized + "=".repeat(padding);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(decoded);
}
function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
function parsePaymentRequired(headerValue) {
  return decodeBase64Json(headerValue);
}
function normalizeNetwork(network) {
  if (!network || network.trim().length === 0) {
    return DEFAULT_NETWORK;
  }
  return network.trim().toLowerCase();
}
function resolveChainId(network) {
  const eip155Match = network.match(/^eip155:(\d+)$/i);
  if (eip155Match) {
    const parsed = Number.parseInt(eip155Match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (network === "base") return BASE_CHAIN_ID;
  if (network === "base-sepolia") return BASE_SEPOLIA_CHAIN_ID;
  return BASE_CHAIN_ID;
}
function parseHexAddress(value) {
  if (!value) return void 0;
  const direct = value.match(/^0x[a-fA-F0-9]{40}$/);
  if (direct) {
    return direct[0];
  }
  const caipSuffix = value.match(/0x[a-fA-F0-9]{40}$/);
  if (caipSuffix) {
    return caipSuffix[0];
  }
  return void 0;
}
function requireHexAddress(value, field) {
  const parsed = parseHexAddress(value);
  if (!parsed) {
    throw new Error(`Invalid ${field} in payment requirements: ${String(value)}`);
  }
  return parsed;
}
function setPaymentHeaders(headers, payload) {
  headers.set("payment-signature", payload);
  headers.set("x-payment", payload);
}
async function createPaymentPayload(privateKey, fromAddress, option, amount, requestUrl, resource) {
  const network = normalizeNetwork(option.network);
  const chainId = resolveChainId(network);
  const recipient = requireHexAddress(option.payTo, "payTo");
  const verifyingContract = requireHexAddress(option.asset, "asset");
  const maxTimeoutSeconds = typeof option.maxTimeoutSeconds === "number" && option.maxTimeoutSeconds > 0 ? Math.floor(option.maxTimeoutSeconds) : DEFAULT_MAX_TIMEOUT_SECONDS;
  const now = Math.floor(Date.now() / 1e3);
  const validAfter = now - 600;
  const validBefore = now + maxTimeoutSeconds;
  const nonce = createNonce();
  const signature = await signTypedData({
    privateKey,
    domain: {
      name: option.extra?.name || DEFAULT_TOKEN_NAME,
      version: option.extra?.version || DEFAULT_TOKEN_VERSION,
      chainId,
      verifyingContract
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAddress,
      to: recipient,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce
    }
  });
  const paymentData = {
    x402Version: 2,
    resource: {
      url: resource?.url || requestUrl,
      description: resource?.description || "BlockRun AI API call",
      mimeType: "application/json"
    },
    accepted: {
      scheme: option.scheme,
      network,
      amount,
      asset: option.asset,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      extra: option.extra
    },
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce
      }
    },
    extensions: {}
  };
  return encodeBase64Json(paymentData);
}
function createPaymentFetch(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const walletAddress = account.address;
  const paymentCache = new PaymentCache();
  const payFetch = async (input, init, preAuth) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpointPath = new URL(url).pathname;
    const cached = paymentCache.get(endpointPath);
    if (cached && preAuth?.estimatedAmount) {
      const paymentPayload = await createPaymentPayload(
        privateKey,
        walletAddress,
        {
          scheme: cached.scheme,
          network: cached.network,
          asset: cached.asset,
          payTo: cached.payTo,
          maxTimeoutSeconds: cached.maxTimeoutSeconds,
          extra: cached.extra
        },
        preAuth.estimatedAmount,
        url,
        {
          url: cached.resourceUrl,
          description: cached.resourceDescription
        }
      );
      const preAuthHeaders = new Headers(init?.headers);
      setPaymentHeaders(preAuthHeaders, paymentPayload);
      const response2 = await fetch(input, { ...init, headers: preAuthHeaders });
      if (response2.status !== 402) {
        return response2;
      }
      const paymentHeader2 = response2.headers.get("x-payment-required");
      if (paymentHeader2) {
        return handle402(input, init, url, endpointPath, paymentHeader2);
      }
      paymentCache.invalidate(endpointPath);
      const cleanResponse = await fetch(input, init);
      if (cleanResponse.status !== 402) {
        return cleanResponse;
      }
      const cleanHeader = cleanResponse.headers.get("x-payment-required");
      if (!cleanHeader) {
        throw new Error("402 response missing x-payment-required header");
      }
      return handle402(input, init, url, endpointPath, cleanHeader);
    }
    const response = await fetch(input, init);
    if (response.status !== 402) {
      return response;
    }
    const paymentHeader = response.headers.get("x-payment-required");
    if (!paymentHeader) {
      throw new Error("402 response missing x-payment-required header");
    }
    return handle402(input, init, url, endpointPath, paymentHeader);
  };
  async function handle402(input, init, url, endpointPath, paymentHeader) {
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const option = paymentRequired.accepts?.[0];
    if (!option) {
      throw new Error("No payment options in 402 response");
    }
    const amount = option.amount || option.maxAmountRequired;
    if (!amount) {
      throw new Error("No amount in payment requirements");
    }
    paymentCache.set(endpointPath, {
      payTo: option.payTo,
      asset: option.asset,
      scheme: option.scheme,
      network: option.network,
      extra: option.extra,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      resourceUrl: paymentRequired.resource?.url,
      resourceDescription: paymentRequired.resource?.description
    });
    const paymentPayload = await createPaymentPayload(
      privateKey,
      walletAddress,
      option,
      amount,
      url,
      paymentRequired.resource
    );
    const retryHeaders = new Headers(init?.headers);
    setPaymentHeaders(retryHeaders, paymentPayload);
    return fetch(input, {
      ...init,
      headers: retryHeaders
    });
  }
  return { fetch: payFetch, cache: paymentCache };
}

// src/logger.ts
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
var LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");
var dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}
async function logUsage(entry) {
  try {
    await ensureDir();
    const date = entry.timestamp.slice(0, 10);
    const file = join(LOG_DIR, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
  }
}

// src/stats.ts
import { readFile, readdir } from "fs/promises";
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";

// src/version.ts
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join as join2 } from "path";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var require2 = createRequire(import.meta.url);
var pkg = require2(join2(__dirname, "..", "package.json"));
var VERSION = pkg.version;
var USER_AGENT = `clawrouter/${VERSION}`;

// src/stats.ts
var LOG_DIR2 = join3(homedir2(), ".openclaw", "blockrun", "logs");
async function parseLogFile(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const entry = JSON.parse(line);
      return {
        timestamp: entry.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
        model: entry.model || "unknown",
        tier: entry.tier || "UNKNOWN",
        cost: entry.cost || 0,
        baselineCost: entry.baselineCost || entry.cost || 0,
        savings: entry.savings || 0,
        latencyMs: entry.latencyMs || 0
      };
    });
  } catch {
    return [];
  }
}
async function getLogFiles() {
  try {
    const files = await readdir(LOG_DIR2);
    return files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
function aggregateDay(date, entries) {
  const byTier = {};
  const byModel = {};
  let totalLatency = 0;
  for (const entry of entries) {
    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;
    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;
    totalLatency += entry.latencyMs;
  }
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);
  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel
  };
}
async function getStats(days = 7) {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);
  const dailyBreakdown = [];
  const allByTier = {};
  const allByModel = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;
  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join3(LOG_DIR2, file);
    const entries = await parseLogFile(filePath);
    if (entries.length === 0) continue;
    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);
    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }
  const byTierWithPercentage = {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const byModelWithPercentage = {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? totalSavings / totalBaselineCost * 100 : 0;
  let entriesWithBaseline = 0;
  for (const day of dailyBreakdown) {
    if (day.totalBaselineCost !== day.totalCost) {
      entriesWithBaseline += day.totalRequests;
    }
  }
  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(),
    // Oldest first for charts
    entriesWithBaseline
    // How many entries have valid baseline tracking
  };
}

// src/dedup.ts
import { createHash } from "crypto";
var DEFAULT_TTL_MS2 = 3e4;
var MAX_BODY_SIZE = 1048576;
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function stripTimestamps(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripTimestamps);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "content" && typeof value === "string") {
      result[key] = value.replace(TIMESTAMP_PATTERN, "");
    } else {
      result[key] = stripTimestamps(value);
    }
  }
  return result;
}
var RequestDeduplicator = class {
  inflight = /* @__PURE__ */ new Map();
  completed = /* @__PURE__ */ new Map();
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS2) {
    this.ttlMs = ttlMs;
  }
  /** Hash request body to create a dedup key. */
  static hash(body) {
    let content = body;
    try {
      const parsed = JSON.parse(body.toString());
      const stripped = stripTimestamps(parsed);
      const canonical = canonicalize(stripped);
      content = Buffer.from(JSON.stringify(canonical));
    } catch {
    }
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  /** Check if a response is cached for this key. */
  getCached(key) {
    const entry = this.completed.get(key);
    if (!entry) return void 0;
    if (Date.now() - entry.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return void 0;
    }
    return entry;
  }
  /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
  getInflight(key) {
    const entry = this.inflight.get(key);
    if (!entry) return void 0;
    return new Promise((resolve) => {
      entry.resolvers.push(resolve);
    });
  }
  /** Mark a request as in-flight. */
  markInflight(key) {
    this.inflight.set(key, {
      resolvers: []
    });
  }
  /** Complete an in-flight request — cache result and notify waiters. */
  complete(key, result) {
    if (result.body.length <= MAX_BODY_SIZE) {
      this.completed.set(key, result);
    }
    const entry = this.inflight.get(key);
    if (entry) {
      for (const resolve of entry.resolvers) {
        resolve(result);
      }
      this.inflight.delete(key);
    }
    this.prune();
  }
  /** Remove an in-flight entry on error (don't cache failures).
   *  Also rejects any waiters so they can retry independently. */
  removeInflight(key) {
    const entry = this.inflight.get(key);
    if (entry) {
      const errorBody = Buffer.from(
        JSON.stringify({
          error: { message: "Original request failed, please retry", type: "dedup_origin_failed" }
        })
      );
      for (const resolve of entry.resolvers) {
        resolve({
          status: 503,
          headers: { "content-type": "application/json" },
          body: errorBody,
          completedAt: Date.now()
        });
      }
      this.inflight.delete(key);
    }
  }
  /** Prune expired completed entries. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
};

// src/response-cache.ts
import { createHash as createHash2 } from "crypto";
var DEFAULT_CONFIG = {
  maxSize: 200,
  defaultTTL: 600,
  maxItemSize: 1048576,
  // 1MB
  enabled: true
};
function canonicalize2(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize2);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize2(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN2 = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function normalizeForCache(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (["stream", "user", "request_id", "x-request-id"].includes(key)) {
      continue;
    }
    if (key === "messages" && Array.isArray(value)) {
      result[key] = value.map((msg) => {
        if (typeof msg === "object" && msg !== null) {
          const m = msg;
          if (typeof m.content === "string") {
            return { ...m, content: m.content.replace(TIMESTAMP_PATTERN2, "") };
          }
        }
        return msg;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}
var ResponseCache = class {
  cache = /* @__PURE__ */ new Map();
  expirationHeap = [];
  config;
  // Stats for monitoring
  stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };
  constructor(config2 = {}) {
    const filtered = Object.fromEntries(
      Object.entries(config2).filter(([, v]) => v !== void 0)
    );
    this.config = { ...DEFAULT_CONFIG, ...filtered };
  }
  /**
   * Generate cache key from request body.
   * Hashes: model + messages + temperature + max_tokens + other params
   */
  static generateKey(body) {
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      const normalized = normalizeForCache(parsed);
      const canonical = canonicalize2(normalized);
      const keyContent = JSON.stringify(canonical);
      return createHash2("sha256").update(keyContent).digest("hex").slice(0, 32);
    } catch {
      const content = typeof body === "string" ? body : body.toString();
      return createHash2("sha256").update(content).digest("hex").slice(0, 32);
    }
  }
  /**
   * Check if caching is enabled for this request.
   * Respects cache control headers and request params.
   */
  shouldCache(body, headers) {
    if (!this.config.enabled) return false;
    if (headers?.["cache-control"]?.includes("no-cache")) {
      return false;
    }
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      if (parsed.cache === false || parsed.no_cache === true) {
        return false;
      }
    } catch {
    }
    return true;
  }
  /**
   * Get cached response if available and not expired.
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return void 0;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return void 0;
    }
    this.stats.hits++;
    return entry;
  }
  /**
   * Cache a response with optional custom TTL.
   */
  set(key, response, ttlSeconds) {
    if (!this.config.enabled || this.config.maxSize <= 0) return;
    if (response.body.length > this.config.maxItemSize) {
      console.log(`[ResponseCache] Skipping cache - item too large: ${response.body.length} bytes`);
      return;
    }
    if (response.status >= 400) {
      return;
    }
    if (this.cache.size >= this.config.maxSize) {
      this.evict();
    }
    const now = Date.now();
    const ttl = ttlSeconds ?? this.config.defaultTTL;
    const expiresAt = now + ttl * 1e3;
    const entry = {
      ...response,
      cachedAt: now,
      expiresAt
    };
    this.cache.set(key, entry);
    this.expirationHeap.push({ expiresAt, key });
  }
  /**
   * Evict expired and oldest entries to make room.
   */
  evict() {
    const now = Date.now();
    this.expirationHeap.sort((a, b) => a.expiresAt - b.expiresAt);
    while (this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap[0];
      const entry = this.cache.get(oldest.key);
      if (!entry || entry.expiresAt !== oldest.expiresAt) {
        this.expirationHeap.shift();
        continue;
      }
      if (oldest.expiresAt <= now) {
        this.cache.delete(oldest.key);
        this.expirationHeap.shift();
        this.stats.evictions++;
      } else {
        break;
      }
    }
    while (this.cache.size >= this.config.maxSize && this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap.shift();
      if (this.cache.has(oldest.key)) {
        this.cache.delete(oldest.key);
        this.stats.evictions++;
      }
    }
  }
  /**
   * Get cache statistics.
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(1) + "%" : "0%";
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate
    };
  }
  /**
   * Clear all cached entries.
   */
  clear() {
    this.cache.clear();
    this.expirationHeap = [];
  }
  /**
   * Check if cache is enabled.
   */
  isEnabled() {
    return this.config.enabled;
  }
};

// src/balance.ts
import { createPublicClient, http, erc20Abi } from "viem";
import { base } from "viem/chains";

// src/errors.ts
var RpcError = class extends Error {
  code = "RPC_ERROR";
  originalError;
  constructor(message, originalError) {
    super(`RPC error: ${message}. Check network connectivity.`);
    this.name = "RpcError";
    this.originalError = originalError;
  }
};

// src/balance.ts
var USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
var CACHE_TTL_MS = 3e4;
var BALANCE_THRESHOLDS = {
  /** Low balance warning threshold: $1.00 */
  LOW_BALANCE_MICROS: 1000000n,
  /** Effectively zero threshold: $0.0001 (covers dust/rounding) */
  ZERO_THRESHOLD: 100n
};
var BalanceMonitor = class {
  client;
  walletAddress;
  /** Cached balance (null = not yet fetched) */
  cachedBalance = null;
  /** Timestamp when cache was last updated */
  cachedAt = 0;
  constructor(walletAddress) {
    this.walletAddress = walletAddress;
    this.client = createPublicClient({
      chain: base,
      transport: http(void 0, {
        timeout: 1e4
        // 10 second timeout to prevent hanging on slow RPC
      })
    });
  }
  /**
   * Check current USDC balance.
   * Uses cache if valid, otherwise fetches from RPC.
   */
  async checkBalance() {
    const now = Date.now();
    if (this.cachedBalance !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return this.buildInfo(this.cachedBalance);
    }
    const balance = await this.fetchBalance();
    this.cachedBalance = balance;
    this.cachedAt = now;
    return this.buildInfo(balance);
  }
  /**
   * Check if balance is sufficient for an estimated cost.
   *
   * @param estimatedCostMicros - Estimated cost in USDC smallest unit (6 decimals)
   */
  async checkSufficient(estimatedCostMicros) {
    const info = await this.checkBalance();
    if (info.balance >= estimatedCostMicros) {
      return { sufficient: true, info };
    }
    const shortfall = estimatedCostMicros - info.balance;
    return {
      sufficient: false,
      info,
      shortfall: this.formatUSDC(shortfall)
    };
  }
  /**
   * Optimistically deduct estimated cost from cached balance.
   * Call this after a successful payment to keep cache accurate.
   *
   * @param amountMicros - Amount to deduct in USDC smallest unit
   */
  deductEstimated(amountMicros) {
    if (this.cachedBalance !== null && this.cachedBalance >= amountMicros) {
      this.cachedBalance -= amountMicros;
    }
  }
  /**
   * Invalidate cache, forcing next checkBalance() to fetch from RPC.
   * Call this after a payment failure to get accurate balance.
   */
  invalidate() {
    this.cachedBalance = null;
    this.cachedAt = 0;
  }
  /**
   * Force refresh balance from RPC (ignores cache).
   */
  async refresh() {
    this.invalidate();
    return this.checkBalance();
  }
  /**
   * Format USDC amount (in micros) as "$X.XX".
   */
  formatUSDC(amountMicros) {
    const dollars = Number(amountMicros) / 1e6;
    return `$${dollars.toFixed(2)}`;
  }
  /**
   * Get the wallet address being monitored.
   */
  getWalletAddress() {
    return this.walletAddress;
  }
  /** Fetch balance from RPC */
  async fetchBalance() {
    try {
      const balance = await this.client.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.walletAddress]
      });
      return balance;
    } catch (error) {
      throw new RpcError(error instanceof Error ? error.message : "Unknown error", error);
    }
  }
  /** Build BalanceInfo from raw balance */
  buildInfo(balance) {
    return {
      balance,
      balanceUSD: this.formatUSDC(balance),
      isLow: balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS,
      isEmpty: balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD,
      walletAddress: this.walletAddress
    };
  }
};

// src/compression/types.ts
var DEFAULT_COMPRESSION_CONFIG = {
  enabled: true,
  preserveRaw: true,
  layers: {
    deduplication: true,
    // Safe: removes duplicate messages
    whitespace: true,
    // Safe: normalizes whitespace
    dictionary: false,
    // DISABLED: requires model to understand codebook
    paths: false,
    // DISABLED: requires model to understand path codes
    jsonCompact: true,
    // Safe: just removes JSON whitespace
    observation: false,
    // DISABLED: may lose important context
    dynamicCodebook: false
    // DISABLED: requires model to understand codes
  },
  dictionary: {
    maxEntries: 50,
    minPhraseLength: 15,
    includeCodebookHeader: false
    // No codebook header needed
  }
};

// src/compression/layers/deduplication.ts
import crypto2 from "crypto";
function hashMessage(message) {
  let contentStr = "";
  if (typeof message.content === "string") {
    contentStr = message.content;
  } else if (Array.isArray(message.content)) {
    contentStr = JSON.stringify(message.content);
  }
  const parts = [message.role, contentStr, message.tool_call_id || "", message.name || ""];
  if (message.tool_calls) {
    parts.push(
      JSON.stringify(
        message.tool_calls.map((tc) => ({
          name: tc.function.name,
          args: tc.function.arguments
        }))
      )
    );
  }
  const content = parts.join("|");
  return crypto2.createHash("md5").update(content).digest("hex");
}
function deduplicateMessages(messages) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  let duplicatesRemoved = 0;
  const referencedToolCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      referencedToolCallIds.add(message.tool_call_id);
    }
  }
  for (const message of messages) {
    if (message.role === "system") {
      result.push(message);
      continue;
    }
    if (message.role === "user") {
      result.push(message);
      continue;
    }
    if (message.role === "tool") {
      result.push(message);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls) {
      const hasReferencedToolCall = message.tool_calls.some(
        (tc) => referencedToolCallIds.has(tc.id)
      );
      if (hasReferencedToolCall) {
        result.push(message);
        continue;
      }
    }
    const hash = hashMessage(message);
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(message);
    } else {
      duplicatesRemoved++;
    }
  }
  return {
    messages: result,
    duplicatesRemoved,
    originalCount: messages.length
  };
}

// src/compression/layers/whitespace.ts
function normalizeWhitespace(content) {
  if (!content || typeof content !== "string") return content;
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").replace(/([^\n]) {2,}/g, "$1 ").replace(/^[ ]{8,}/gm, (match) => "  ".repeat(Math.ceil(match.length / 4))).replace(/\t/g, "  ").trim();
}
function normalizeMessagesWhitespace(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const originalLength = message.content.length;
    const normalizedContent = normalizeWhitespace(message.content);
    charsSaved += originalLength - normalizedContent.length;
    return {
      ...message,
      content: normalizedContent
    };
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/codebook.ts
var STATIC_CODEBOOK = {
  // High-impact: OpenClaw/Agent system prompt patterns (very common)
  $OC01: "unbrowse_",
  // Common prefix in tool names
  $OC02: "<location>",
  $OC03: "</location>",
  $OC04: "<name>",
  $OC05: "</name>",
  $OC06: "<description>",
  $OC07: "</description>",
  $OC08: "(may need login)",
  $OC09: "API skill for OpenClaw",
  $OC10: "endpoints",
  // Skill/tool markers
  $SK01: "<available_skills>",
  $SK02: "</available_skills>",
  $SK03: "<skill>",
  $SK04: "</skill>",
  // Schema patterns (very common in tool definitions)
  $T01: 'type: "function"',
  $T02: '"type": "function"',
  $T03: '"type": "string"',
  $T04: '"type": "object"',
  $T05: '"type": "array"',
  $T06: '"type": "boolean"',
  $T07: '"type": "number"',
  // Common descriptions
  $D01: "description:",
  $D02: '"description":',
  // Common instructions
  $I01: "You are a personal assistant",
  $I02: "Tool names are case-sensitive",
  $I03: "Call tools exactly as listed",
  $I04: "Use when",
  $I05: "without asking",
  // Safety phrases
  $S01: "Do not manipulate or persuade",
  $S02: "Prioritize safety and human oversight",
  $S03: "unless explicitly requested",
  // JSON patterns
  $J01: '"required": ["',
  $J02: '"properties": {',
  $J03: '"additionalProperties": false',
  // Heartbeat patterns
  $H01: "HEARTBEAT_OK",
  $H02: "Read HEARTBEAT.md if it exists",
  // Role markers
  $R01: '"role": "system"',
  $R02: '"role": "user"',
  $R03: '"role": "assistant"',
  $R04: '"role": "tool"',
  // Common endings/phrases
  $E01: "would you like to",
  $E02: "Let me know if you",
  $E03: "internal APIs",
  $E04: "session cookies",
  // BlockRun model aliases (common in prompts)
  $M01: "blockrun/",
  $M02: "openai/",
  $M03: "anthropic/",
  $M04: "google/",
  $M05: "xai/"
};
function getInverseCodebook() {
  const inverse = {};
  for (const [code, phrase] of Object.entries(STATIC_CODEBOOK)) {
    inverse[phrase] = code;
  }
  return inverse;
}
function generateCodebookHeader(usedCodes, pathMap = {}) {
  if (usedCodes.size === 0 && Object.keys(pathMap).length === 0) {
    return "";
  }
  const parts = [];
  if (usedCodes.size > 0) {
    const codeEntries = Array.from(usedCodes).map((code) => `${code}=${STATIC_CODEBOOK[code]}`).join(", ");
    parts.push(`[Dict: ${codeEntries}]`);
  }
  if (Object.keys(pathMap).length > 0) {
    const pathEntries = Object.entries(pathMap).map(([code, path]) => `${code}=${path}`).join(", ");
    parts.push(`[Paths: ${pathEntries}]`);
  }
  return parts.join("\n");
}

// src/compression/layers/dictionary.ts
function encodeContent(content, inverseCodebook) {
  if (!content || typeof content !== "string") {
    return { encoded: content, substitutions: 0, codes: /* @__PURE__ */ new Set(), charsSaved: 0 };
  }
  let encoded = content;
  let substitutions = 0;
  let charsSaved = 0;
  const codes = /* @__PURE__ */ new Set();
  const phrases = Object.keys(inverseCodebook).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const code = inverseCodebook[phrase];
    const regex = new RegExp(escapeRegex(phrase), "g");
    const matches = encoded.match(regex);
    if (matches && matches.length > 0) {
      encoded = encoded.replace(regex, code);
      substitutions += matches.length;
      charsSaved += matches.length * (phrase.length - code.length);
      codes.add(code);
    }
  }
  return { encoded, substitutions, codes, charsSaved };
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function encodeMessages(messages) {
  const inverseCodebook = getInverseCodebook();
  let totalSubstitutions = 0;
  let totalCharsSaved = 0;
  const allUsedCodes = /* @__PURE__ */ new Set();
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const { encoded, substitutions, codes, charsSaved } = encodeContent(
      message.content,
      inverseCodebook
    );
    totalSubstitutions += substitutions;
    totalCharsSaved += charsSaved;
    codes.forEach((code) => allUsedCodes.add(code));
    return {
      ...message,
      content: encoded
    };
  });
  return {
    messages: result,
    substitutionCount: totalSubstitutions,
    usedCodes: allUsedCodes,
    charsSaved: totalCharsSaved
  };
}

// src/compression/layers/paths.ts
var PATH_REGEX = /(?:\/[\w.-]+){3,}/g;
function extractPaths(messages) {
  const paths = [];
  for (const message of messages) {
    if (!message.content || typeof message.content !== "string") continue;
    const matches = message.content.match(PATH_REGEX);
    if (matches) {
      paths.push(...matches);
    }
  }
  return paths;
}
function findFrequentPrefixes(paths) {
  const prefixCounts = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 2; i < parts.length; i++) {
      const prefix = "/" + parts.slice(0, i).join("/") + "/";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }
  return Array.from(prefixCounts.entries()).filter(([, count]) => count >= 3).sort((a, b) => b[0].length - a[0].length).slice(0, 5).map(([prefix]) => prefix);
}
function shortenPaths(messages) {
  const allPaths = extractPaths(messages);
  if (allPaths.length < 5) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const prefixes = findFrequentPrefixes(allPaths);
  if (prefixes.length === 0) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const pathMap = {};
  prefixes.forEach((prefix, i) => {
    pathMap[`$P${i + 1}`] = prefix;
  });
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    let content = message.content;
    const originalLength = content.length;
    for (const [code, prefix] of Object.entries(pathMap)) {
      content = content.split(prefix).join(code + "/");
    }
    charsSaved += originalLength - content.length;
    return {
      ...message,
      content
    };
  });
  return {
    messages: result,
    pathMap,
    charsSaved
  };
}

// src/compression/layers/json-compact.ts
function compactJson(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    return JSON.stringify(parsed);
  } catch {
    return jsonString;
  }
}
function looksLikeJson(str) {
  const trimmed = str.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]");
}
function compactToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    ...tc,
    function: {
      ...tc.function,
      arguments: compactJson(tc.function.arguments)
    }
  }));
}
function compactMessagesJson(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    const newMessage = { ...message };
    if (message.tool_calls && message.tool_calls.length > 0) {
      const originalLength = JSON.stringify(message.tool_calls).length;
      newMessage.tool_calls = compactToolCalls(message.tool_calls);
      const newLength = JSON.stringify(newMessage.tool_calls).length;
      charsSaved += originalLength - newLength;
    }
    if (message.role === "tool" && message.content && typeof message.content === "string" && looksLikeJson(message.content)) {
      const originalLength = message.content.length;
      const compacted = compactJson(message.content);
      charsSaved += originalLength - compacted.length;
      newMessage.content = compacted;
    }
    return newMessage;
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/layers/observation.ts
var TOOL_RESULT_THRESHOLD = 500;
var COMPRESSED_RESULT_MAX = 300;
function compressToolResult(content) {
  if (!content || content.length <= TOOL_RESULT_THRESHOLD) {
    return content;
  }
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter(
    (l) => /error|exception|failed|denied|refused|timeout|invalid/i.test(l) && l.length < 200
  );
  const statusLines = lines.filter(
    (l) => /success|complete|created|updated|found|result|status|total|count/i.test(l) && l.length < 150
  );
  const jsonMatches = [];
  const jsonPattern = /"(id|name|status|error|message|count|total|url|path)":\s*"?([^",}\n]+)"?/gi;
  let match;
  while ((match = jsonPattern.exec(content)) !== null) {
    jsonMatches.push(`${match[1]}: ${match[2].slice(0, 50)}`);
  }
  const firstLine = lines[0]?.slice(0, 100);
  const lastLine = lines.length > 1 ? lines[lines.length - 1]?.slice(0, 100) : "";
  const parts = [];
  if (errorLines.length > 0) {
    parts.push("[ERR] " + errorLines.slice(0, 3).join(" | "));
  }
  if (statusLines.length > 0) {
    parts.push(statusLines.slice(0, 3).join(" | "));
  }
  if (jsonMatches.length > 0) {
    parts.push(jsonMatches.slice(0, 5).join(", "));
  }
  if (parts.length === 0) {
    parts.push(firstLine || "");
    if (lines.length > 2) {
      parts.push(`[...${lines.length - 2} lines...]`);
    }
    if (lastLine && lastLine !== firstLine) {
      parts.push(lastLine);
    }
  }
  let result = parts.join("\n");
  if (result.length > COMPRESSED_RESULT_MAX) {
    result = result.slice(0, COMPRESSED_RESULT_MAX - 20) + "\n[...truncated]";
  }
  return result;
}
function deduplicateLargeBlocks(messages) {
  const blockHashes = /* @__PURE__ */ new Map();
  let charsSaved = 0;
  const result = messages.map((msg, idx) => {
    if (!msg.content || typeof msg.content !== "string" || msg.content.length < 500) {
      return msg;
    }
    const blockKey = msg.content.slice(0, 200);
    if (blockHashes.has(blockKey)) {
      const firstIdx = blockHashes.get(blockKey);
      const original = msg.content;
      const compressed = `[See message #${firstIdx + 1} - same content]`;
      charsSaved += original.length - compressed.length;
      return { ...msg, content: compressed };
    }
    blockHashes.set(blockKey, idx);
    return msg;
  });
  return { messages: result, charsSaved };
}
function compressObservations(messages) {
  let charsSaved = 0;
  let observationsCompressed = 0;
  let result = messages.map((msg) => {
    if (msg.role !== "tool" || !msg.content || typeof msg.content !== "string") {
      return msg;
    }
    const original = msg.content;
    if (original.length <= TOOL_RESULT_THRESHOLD) {
      return msg;
    }
    const compressed = compressToolResult(original);
    const saved = original.length - compressed.length;
    if (saved > 50) {
      charsSaved += saved;
      observationsCompressed++;
      return { ...msg, content: compressed };
    }
    return msg;
  });
  const dedupResult = deduplicateLargeBlocks(result);
  result = dedupResult.messages;
  charsSaved += dedupResult.charsSaved;
  return {
    messages: result,
    charsSaved,
    observationsCompressed
  };
}

// src/compression/layers/dynamic-codebook.ts
var MIN_PHRASE_LENGTH = 20;
var MAX_PHRASE_LENGTH = 200;
var MIN_FREQUENCY = 3;
var MAX_ENTRIES = 100;
var CODE_PREFIX = "$D";
function findRepeatedPhrases(allContent) {
  const phrases = /* @__PURE__ */ new Map();
  const segments = allContent.split(/(?<=[.!?\n])\s+/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  const lines = allContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  return phrases;
}
function buildDynamicCodebook(messages) {
  let allContent = "";
  for (const msg of messages) {
    if (msg.content && typeof msg.content === "string") {
      allContent += msg.content + "\n";
    }
  }
  const phrases = findRepeatedPhrases(allContent);
  const candidates = [];
  for (const [phrase, count] of phrases.entries()) {
    if (count >= MIN_FREQUENCY) {
      const codeLength = 4;
      const savings = (phrase.length - codeLength) * count;
      if (savings > 50) {
        candidates.push({ phrase, count, savings });
      }
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  const topCandidates = candidates.slice(0, MAX_ENTRIES);
  const codebook = {};
  topCandidates.forEach((c, i) => {
    const code = `${CODE_PREFIX}${String(i + 1).padStart(2, "0")}`;
    codebook[code] = c.phrase;
  });
  return codebook;
}
function escapeRegex2(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function applyDynamicCodebook(messages) {
  const codebook = buildDynamicCodebook(messages);
  if (Object.keys(codebook).length === 0) {
    return {
      messages,
      charsSaved: 0,
      dynamicCodes: {},
      substitutions: 0
    };
  }
  const phraseToCode = {};
  for (const [code, phrase] of Object.entries(codebook)) {
    phraseToCode[phrase] = code;
  }
  const sortedPhrases = Object.keys(phraseToCode).sort((a, b) => b.length - a.length);
  let charsSaved = 0;
  let substitutions = 0;
  const result = messages.map((msg) => {
    if (!msg.content || typeof msg.content !== "string") return msg;
    let content = msg.content;
    for (const phrase of sortedPhrases) {
      const code = phraseToCode[phrase];
      const regex = new RegExp(escapeRegex2(phrase), "g");
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, code);
        charsSaved += (phrase.length - code.length) * matches.length;
        substitutions += matches.length;
      }
    }
    return { ...msg, content };
  });
  return {
    messages: result,
    charsSaved,
    dynamicCodes: codebook,
    substitutions
  };
}
function generateDynamicCodebookHeader(codebook) {
  if (Object.keys(codebook).length === 0) return "";
  const entries = Object.entries(codebook).slice(0, 20).map(([code, phrase]) => {
    const displayPhrase = phrase.length > 40 ? phrase.slice(0, 37) + "..." : phrase;
    return `${code}=${displayPhrase}`;
  }).join(", ");
  return `[DynDict: ${entries}]`;
}

// src/compression/index.ts
function calculateTotalChars(messages) {
  return messages.reduce((total, msg) => {
    let chars = 0;
    if (typeof msg.content === "string") {
      chars = msg.content.length;
    } else if (Array.isArray(msg.content)) {
      chars = JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
    return total + chars;
  }, 0);
}
function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}
function prependCodebookHeader(messages, usedCodes, pathMap) {
  const header = generateCodebookHeader(usedCodes, pathMap);
  if (!header) return messages;
  const userIndex = messages.findIndex((m) => m.role === "user");
  if (userIndex === -1) {
    return [{ role: "system", content: header }, ...messages];
  }
  return messages.map((msg, i) => {
    if (i === userIndex) {
      if (typeof msg.content === "string") {
        return {
          ...msg,
          content: `${header}

${msg.content}`
        };
      }
    }
    return msg;
  });
}
async function compressContext(messages, config2 = {}) {
  const fullConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    ...config2,
    layers: {
      ...DEFAULT_COMPRESSION_CONFIG.layers,
      ...config2.layers
    },
    dictionary: {
      ...DEFAULT_COMPRESSION_CONFIG.dictionary,
      ...config2.dictionary
    }
  };
  if (!fullConfig.enabled) {
    const originalChars2 = calculateTotalChars(messages);
    return {
      messages,
      originalMessages: messages,
      originalChars: originalChars2,
      compressedChars: originalChars2,
      compressionRatio: 1,
      stats: {
        duplicatesRemoved: 0,
        whitespaceSavedChars: 0,
        dictionarySubstitutions: 0,
        pathsShortened: 0,
        jsonCompactedChars: 0,
        observationsCompressed: 0,
        observationCharsSaved: 0,
        dynamicSubstitutions: 0,
        dynamicCharsSaved: 0
      },
      codebook: {},
      pathMap: {},
      dynamicCodes: {}
    };
  }
  const originalMessages = fullConfig.preserveRaw ? cloneMessages(messages) : messages;
  const originalChars = calculateTotalChars(messages);
  const stats = {
    duplicatesRemoved: 0,
    whitespaceSavedChars: 0,
    dictionarySubstitutions: 0,
    pathsShortened: 0,
    jsonCompactedChars: 0,
    observationsCompressed: 0,
    observationCharsSaved: 0,
    dynamicSubstitutions: 0,
    dynamicCharsSaved: 0
  };
  let result = cloneMessages(messages);
  let usedCodes = /* @__PURE__ */ new Set();
  let pathMap = {};
  let dynamicCodes = {};
  if (fullConfig.layers.deduplication) {
    const dedupResult = deduplicateMessages(result);
    result = dedupResult.messages;
    stats.duplicatesRemoved = dedupResult.duplicatesRemoved;
  }
  if (fullConfig.layers.whitespace) {
    const wsResult = normalizeMessagesWhitespace(result);
    result = wsResult.messages;
    stats.whitespaceSavedChars = wsResult.charsSaved;
  }
  if (fullConfig.layers.dictionary) {
    const dictResult = encodeMessages(result);
    result = dictResult.messages;
    stats.dictionarySubstitutions = dictResult.substitutionCount;
    usedCodes = dictResult.usedCodes;
  }
  if (fullConfig.layers.paths) {
    const pathResult = shortenPaths(result);
    result = pathResult.messages;
    pathMap = pathResult.pathMap;
    stats.pathsShortened = Object.keys(pathMap).length;
  }
  if (fullConfig.layers.jsonCompact) {
    const jsonResult = compactMessagesJson(result);
    result = jsonResult.messages;
    stats.jsonCompactedChars = jsonResult.charsSaved;
  }
  if (fullConfig.layers.observation) {
    const obsResult = compressObservations(result);
    result = obsResult.messages;
    stats.observationsCompressed = obsResult.observationsCompressed;
    stats.observationCharsSaved = obsResult.charsSaved;
  }
  if (fullConfig.layers.dynamicCodebook) {
    const dynResult = applyDynamicCodebook(result);
    result = dynResult.messages;
    stats.dynamicSubstitutions = dynResult.substitutions;
    stats.dynamicCharsSaved = dynResult.charsSaved;
    dynamicCodes = dynResult.dynamicCodes;
  }
  if (fullConfig.dictionary.includeCodebookHeader && (usedCodes.size > 0 || Object.keys(pathMap).length > 0 || Object.keys(dynamicCodes).length > 0)) {
    result = prependCodebookHeader(result, usedCodes, pathMap);
    if (Object.keys(dynamicCodes).length > 0) {
      const dynHeader = generateDynamicCodebookHeader(dynamicCodes);
      if (dynHeader) {
        const systemIndex = result.findIndex((m) => m.role === "system");
        if (systemIndex >= 0 && typeof result[systemIndex].content === "string") {
          result[systemIndex] = {
            ...result[systemIndex],
            content: `${dynHeader}
${result[systemIndex].content}`
          };
        }
      }
    }
  }
  const compressedChars = calculateTotalChars(result);
  const compressionRatio = compressedChars / originalChars;
  const usedCodebook = {};
  usedCodes.forEach((code) => {
    usedCodebook[code] = STATIC_CODEBOOK[code];
  });
  return {
    messages: result,
    originalMessages,
    originalChars,
    compressedChars,
    compressionRatio,
    stats,
    codebook: usedCodebook,
    pathMap,
    dynamicCodes
  };
}
function shouldCompress(messages) {
  const chars = calculateTotalChars(messages);
  return chars > 5e3;
}

// src/session.ts
var DEFAULT_SESSION_CONFIG = {
  enabled: false,
  timeoutMs: 30 * 60 * 1e3,
  // 30 minutes
  headerName: "x-session-id"
};
var SessionStore = class {
  sessions = /* @__PURE__ */ new Map();
  config;
  cleanupInterval = null;
  constructor(config2 = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config2 };
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1e3);
    }
  }
  /**
   * Get the pinned model for a session, if any.
   */
  getSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return void 0;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return void 0;
    }
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return void 0;
    }
    return entry;
  }
  /**
   * Pin a model to a session.
   */
  setSession(sessionId, model, tier) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1
      });
    }
  }
  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }
  /**
   * Clear a specific session.
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
  /**
   * Clear all sessions.
   */
  clearAll() {
    this.sessions.clear();
  }
  /**
   * Get session stats for debugging.
   */
  getStats() {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1e3)
    }));
    return { count: this.sessions.size, sessions };
  }
  /**
   * Clean up expired sessions.
   */
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }
  /**
   * Stop the cleanup interval.
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
};
function getSessionId(headers, headerName = DEFAULT_SESSION_CONFIG.headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return void 0;
}

// src/updater.ts
var NPM_REGISTRY = "https://registry.npmjs.org/@blockrun/clawrouter/latest";
var UPDATE_URL = "https://blockrun.ai/ClawRouter-update";
var CHECK_TIMEOUT_MS = 5e3;
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
async function checkForUpdates() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const res = await fetch(NPM_REGISTRY, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (!latest) return;
    if (compareSemver(latest, VERSION) > 0) {
      console.log("");
      console.log(`\x1B[33m\u2B06\uFE0F  ClawRouter ${latest} available (you have ${VERSION})\x1B[0m`);
      console.log(`   Run: \x1B[36mcurl -fsSL ${UPDATE_URL} | bash\x1B[0m`);
      console.log("");
    }
  } catch {
  }
}

// src/config.ts
var DEFAULT_PORT = 8402;
var PROXY_PORT = (() => {
  const envPort = process.env.BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
})();

// src/journal.ts
var DEFAULT_CONFIG2 = {
  maxEntries: 100,
  maxAgeMs: 24 * 60 * 60 * 1e3,
  // 24 hours
  maxEventsPerResponse: 5
};
var SessionJournal = class {
  journals = /* @__PURE__ */ new Map();
  config;
  constructor(config2) {
    this.config = { ...DEFAULT_CONFIG2, ...config2 };
  }
  /**
   * Extract key events from assistant response content.
   * Looks for patterns like "I created...", "I fixed...", "Successfully..."
   */
  extractEvents(content) {
    if (!content || typeof content !== "string") {
      return [];
    }
    const events = [];
    const seen = /* @__PURE__ */ new Set();
    const patterns = [
      // Creation patterns
      /I (?:also |then |have |)?(?:created|implemented|added|wrote|built|generated|set up|initialized) ([^.!?\n]{10,150})/gi,
      // Fix patterns
      /I (?:also |then |have |)?(?:fixed|resolved|solved|patched|corrected|addressed|debugged) ([^.!?\n]{10,150})/gi,
      // Completion patterns
      /I (?:also |then |have |)?(?:completed|finished|done with|wrapped up) ([^.!?\n]{10,150})/gi,
      // Update patterns
      /I (?:also |then |have |)?(?:updated|modified|changed|refactored|improved|enhanced|optimized) ([^.!?\n]{10,150})/gi,
      // Success patterns
      /Successfully ([^.!?\n]{10,150})/gi,
      // Tool usage patterns (when agent uses tools)
      /I (?:also |then |have |)?(?:ran|executed|called|invoked) ([^.!?\n]{10,100})/gi
    ];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const action = match[0].trim();
        const normalized = action.toLowerCase();
        if (seen.has(normalized)) {
          continue;
        }
        if (action.length >= 15 && action.length <= 200) {
          events.push(action);
          seen.add(normalized);
        }
        if (events.length >= this.config.maxEventsPerResponse) {
          break;
        }
      }
      if (events.length >= this.config.maxEventsPerResponse) {
        break;
      }
    }
    return events;
  }
  /**
   * Record events to the session journal.
   */
  record(sessionId, events, model) {
    if (!sessionId || !events.length) {
      return;
    }
    const journal = this.journals.get(sessionId) || [];
    const now = Date.now();
    for (const action of events) {
      journal.push({
        timestamp: now,
        action,
        model
      });
    }
    const cutoff = now - this.config.maxAgeMs;
    const trimmed = journal.filter((e) => e.timestamp > cutoff).slice(-this.config.maxEntries);
    this.journals.set(sessionId, trimmed);
  }
  /**
   * Check if the user message indicates a need for historical context.
   */
  needsContext(lastUserMessage) {
    if (!lastUserMessage || typeof lastUserMessage !== "string") {
      return false;
    }
    const lower = lastUserMessage.toLowerCase();
    const triggers = [
      // Direct questions about past work
      "what did you do",
      "what have you done",
      "what did we do",
      "what have we done",
      // Temporal references
      "earlier",
      "before",
      "previously",
      "this session",
      "today",
      "so far",
      // Summary requests
      "remind me",
      "summarize",
      "summary of",
      "recap",
      // Progress inquiries
      "your work",
      "your progress",
      "accomplished",
      "achievements",
      "completed tasks"
    ];
    return triggers.some((t) => lower.includes(t));
  }
  /**
   * Format the journal for injection into system message.
   * Returns null if journal is empty.
   */
  format(sessionId) {
    const journal = this.journals.get(sessionId);
    if (!journal?.length) {
      return null;
    }
    const lines = journal.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      });
      return `- ${time}: ${e.action}`;
    });
    return `[Session Memory - Key Actions]
${lines.join("\n")}`;
  }
  /**
   * Get the raw journal entries for a session (for debugging/testing).
   */
  getEntries(sessionId) {
    return this.journals.get(sessionId) || [];
  }
  /**
   * Clear journal for a specific session.
   */
  clear(sessionId) {
    this.journals.delete(sessionId);
  }
  /**
   * Clear all journals.
   */
  clearAll() {
    this.journals.clear();
  }
  /**
   * Get stats about the journal.
   */
  getStats() {
    let totalEntries = 0;
    for (const entries of this.journals.values()) {
      totalEntries += entries.length;
    }
    return {
      sessions: this.journals.size,
      totalEntries
    };
  }
};

// src/proxy.ts
var BLOCKRUN_API = "https://blockrun.ai/api";
var AUTO_MODEL = "blockrun/auto";
var ROUTING_PROFILES = /* @__PURE__ */ new Set([
  "blockrun/free",
  "free",
  "blockrun/eco",
  "eco",
  "blockrun/auto",
  "auto",
  "blockrun/premium",
  "premium"
]);
var FREE_MODEL = "nvidia/gpt-oss-120b";
var MAX_MESSAGES = 200;
var HEARTBEAT_INTERVAL_MS = 2e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 18e4;
var MAX_FALLBACK_ATTEMPTS = 5;
var HEALTH_CHECK_TIMEOUT_MS = 2e3;
var RATE_LIMIT_COOLDOWN_MS = 6e4;
var PORT_RETRY_ATTEMPTS = 5;
var PORT_RETRY_DELAY_MS = 1e3;
function transformPaymentError(errorBody) {
  try {
    const parsed = JSON.parse(errorBody);
    if (parsed.error === "Payment verification failed" && parsed.details) {
      const match = parsed.details.match(/Verification failed:\s*(\{.*\})/s);
      if (match) {
        const innerJson = JSON.parse(match[1]);
        if (innerJson.invalidReason === "insufficient_funds" && innerJson.invalidMessage) {
          const balanceMatch = innerJson.invalidMessage.match(
            /insufficient balance:\s*(\d+)\s*<\s*(\d+)/i
          );
          if (balanceMatch) {
            const currentMicros = parseInt(balanceMatch[1], 10);
            const requiredMicros = parseInt(balanceMatch[2], 10);
            const currentUSD = (currentMicros / 1e6).toFixed(6);
            const requiredUSD = (requiredMicros / 1e6).toFixed(6);
            const wallet = innerJson.payer || "unknown";
            const shortWallet = wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
            return JSON.stringify({
              error: {
                message: `Insufficient USDC balance. Current: $${currentUSD}, Required: ~$${requiredUSD}`,
                type: "insufficient_funds",
                wallet,
                current_balance_usd: currentUSD,
                required_usd: requiredUSD,
                help: `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`
              }
            });
          }
        }
        if (innerJson.invalidReason === "invalid_payload") {
          return JSON.stringify({
            error: {
              message: "Payment signature invalid. This may be a temporary issue.",
              type: "invalid_payload",
              help: "Try again. If this persists, reinstall ClawRouter: curl -fsSL https://blockrun.ai/ClawRouter-update | bash"
            }
          });
        }
      }
    }
    if (parsed.error === "Settlement failed" || parsed.details?.includes("Settlement failed")) {
      const details = parsed.details || "";
      const gasError = details.includes("unable to estimate gas");
      return JSON.stringify({
        error: {
          message: gasError ? "Payment failed: network congestion or gas issue. Try again." : "Payment settlement failed. Try again in a moment.",
          type: "settlement_failed",
          help: "This is usually temporary. If it persists, try: /model free"
        }
      });
    }
  } catch {
  }
  return errorBody;
}
var rateLimitedModels = /* @__PURE__ */ new Map();
function isRateLimited(modelId) {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  const elapsed = Date.now() - hitTime;
  if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}
function markRateLimited(modelId) {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}
function prioritizeNonRateLimited(models) {
  const available = [];
  const rateLimited = [];
  for (const model of models) {
    if (isRateLimited(model)) {
      rateLimited.push(model);
    } else {
      available.push(model);
    }
  }
  return [...available, ...rateLimited];
}
function canWrite(res) {
  return !res.writableEnded && !res.destroyed && res.socket !== null && !res.socket.destroyed && res.socket.writable;
}
function safeWrite(res, data) {
  if (!canWrite(res)) {
    return false;
  }
  return res.write(data);
}
var BALANCE_CHECK_BUFFER = 1.5;
function getProxyPort() {
  return PROXY_PORT;
}
async function checkExistingProxy(port) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data.status === "ok" && data.wallet) {
        return data.wallet;
      }
    }
    return void 0;
  } catch {
    clearTimeout(timeoutId);
    return void 0;
  }
}
var PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /model.*not.*available/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
  /request too large/i,
  /request.*size.*exceeds/i,
  /payload too large/i
];
var FALLBACK_STATUS_CODES = [
  400,
  // Bad request - sometimes used for billing errors
  401,
  // Unauthorized - provider API key issues
  402,
  // Payment required - but from upstream, not x402
  403,
  // Forbidden - provider restrictions
  413,
  // Payload too large - request exceeds model's context limit
  429,
  // Rate limited
  500,
  // Internal server error
  502,
  // Bad gateway
  503,
  // Service unavailable
  504
  // Gateway timeout
];
function isProviderError(status, body) {
  if (!FALLBACK_STATUS_CODES.includes(status)) {
    return false;
  }
  if (status >= 500) {
    return true;
  }
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}
var VALID_ROLES = /* @__PURE__ */ new Set(["system", "user", "assistant", "tool", "function"]);
var ROLE_MAPPINGS = {
  developer: "system",
  // OpenAI's newer API uses "developer" for system messages
  model: "assistant"
  // Some APIs use "model" instead of "assistant"
};
var VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function sanitizeToolIds(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg;
    let msgChanged = false;
    let newMsg = { ...msg };
    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const sanitized2 = sanitizeToolId(tc.id);
          if (sanitized2 !== tc.id) {
            msgChanged = true;
            return { ...tc, id: sanitized2 };
          }
        }
        return tc;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, tool_calls: newToolCalls };
      }
    }
    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const sanitized2 = sanitizeToolId(typedMsg.tool_call_id);
      if (sanitized2 !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: sanitized2 };
      }
    }
    if (Array.isArray(typedMsg.content)) {
      const newContent = typedMsg.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        let blockChanged = false;
        let newBlock = { ...block };
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const sanitized2 = sanitizeToolId(block.id);
          if (sanitized2 !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: sanitized2 };
          }
        }
        if (block.type === "tool_result" && block.tool_use_id && typeof block.tool_use_id === "string") {
          const sanitized2 = sanitizeToolId(block.tool_use_id);
          if (sanitized2 !== block.tool_use_id) {
            blockChanged = true;
            newBlock = { ...newBlock, tool_use_id: sanitized2 };
          }
        }
        if (blockChanged) {
          msgChanged = true;
          return newBlock;
        }
        return block;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, content: newContent };
      }
    }
    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });
  return hasChanges ? sanitized : messages;
}
function normalizeMessageRoles(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;
    const mappedRole = ROLE_MAPPINGS[msg.role];
    if (mappedRole) {
      hasChanges = true;
      return { ...msg, role: mappedRole };
    }
    hasChanges = true;
    return { ...msg, role: "user" };
  });
  return hasChanges ? normalized : messages;
}
function normalizeMessagesForGoogle(messages) {
  if (!messages || messages.length === 0) return messages;
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }
  if (firstNonSystemIdx === -1) return messages;
  const firstRole = messages[firstNonSystemIdx].role;
  if (firstRole === "user") return messages;
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "(continuing conversation)"
    });
    return normalized;
  }
  return messages;
}
function isGoogleModel(modelId) {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}
function normalizeMessagesForThinking(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (msg.role !== "assistant" || msg.reasoning_content !== void 0) {
      return msg;
    }
    const hasOpenAIToolCalls = msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasAnthropicToolUse = Array.isArray(msg.content) && msg.content.some((block) => block?.type === "tool_use");
    if (hasOpenAIToolCalls || hasAnthropicToolUse) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });
  return hasChanges ? normalized : messages;
}
function truncateMessages(messages) {
  if (!messages || messages.length <= MAX_MESSAGES) return messages;
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversationMsgs = messages.filter((m) => m.role !== "system");
  const maxConversation = MAX_MESSAGES - systemMsgs.length;
  const truncatedConversation = conversationMsgs.slice(-maxConversation);
  console.log(
    `[ClawRouter] Truncated messages: ${messages.length} \u2192 ${systemMsgs.length + truncatedConversation.length} (kept ${systemMsgs.length} system + ${truncatedConversation.length} recent)`
  );
  return [...systemMsgs, ...truncatedConversation];
}
var KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;
var KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;
var THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;
var THINKING_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
function stripThinkingTokens(content) {
  if (!content) return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}
function buildModelPricing() {
  const map = /* @__PURE__ */ new Map();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}
function mergeRoutingConfig(overrides) {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides }
  };
}
function estimateAmount(modelId, bodyLength, maxTokens) {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  if (!model) return void 0;
  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;
  const costUsd = estimatedInputTokens / 1e6 * model.inputPrice + estimatedOutputTokens / 1e6 * model.outputPrice;
  const amountMicros = Math.max(100, Math.ceil(costUsd * 1.2 * 1e6));
  return amountMicros.toString();
}
async function startProxy(options) {
  const apiBase = options.apiBase ?? BLOCKRUN_API;
  const listenPort = options.port ?? getProxyPort();
  const existingWallet = await checkExistingProxy(listenPort);
  if (existingWallet) {
    const account2 = privateKeyToAccount2(options.walletKey);
    const balanceMonitor2 = new BalanceMonitor(account2.address);
    const baseUrl2 = `http://127.0.0.1:${listenPort}`;
    if (existingWallet !== account2.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingWallet}, but current config uses ${account2.address}. Reusing existing proxy.`
      );
    }
    options.onReady?.(listenPort);
    return {
      port: listenPort,
      baseUrl: baseUrl2,
      walletAddress: existingWallet,
      balanceMonitor: balanceMonitor2,
      close: async () => {
      }
    };
  }
  const account = privateKeyToAccount2(options.walletKey);
  const { fetch: payFetch } = createPaymentFetch(options.walletKey);
  const balanceMonitor = new BalanceMonitor(account.address);
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing2 = buildModelPricing();
  const routerOpts2 = {
    config: routingConfig,
    modelPricing: modelPricing2
  };
  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const connections = /* @__PURE__ */ new Set();
  const server = createServer(async (req, res) => {
    req.on("error", (err) => {
      console.error(`[ClawRouter] Request stream error: ${err.message}`);
    });
    res.on("error", (err) => {
      console.error(`[ClawRouter] Response stream error: ${err.message}`);
    });
    finished(res, (err) => {
      if (err && err.code !== "ERR_STREAM_DESTROYED") {
        console.error(`[ClawRouter] Response finished with error: ${err.message}`);
      }
    });
    finished(req, (err) => {
      if (err && err.code !== "ERR_STREAM_DESTROYED") {
        console.error(`[ClawRouter] Request finished with error: ${err.message}`);
      }
    });
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      const url = new URL(req.url, "http://localhost");
      const full = url.searchParams.get("full") === "true";
      const response = {
        status: "ok",
        wallet: account.address
      };
      if (full) {
        try {
          const balanceInfo = await balanceMonitor.checkBalance();
          response.balance = balanceInfo.balanceUSD;
          response.isLow = balanceInfo.isLow;
          response.isEmpty = balanceInfo.isEmpty;
        } catch {
          response.balanceError = "Could not fetch balance";
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    if (req.url === "/cache" || req.url?.startsWith("/cache?")) {
      const stats = responseCache.getStats();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }
    if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const stats = await getStats(Math.min(days, 30));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        });
        res.end(JSON.stringify(stats, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`
          })
        );
      }
      return;
    }
    if (req.url === "/v1/models" && req.method === "GET") {
      const models = BLOCKRUN_MODELS.filter((m) => m.id !== "blockrun/auto").map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1e3),
        owned_by: m.id.split("/")[0] || "unknown"
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      await proxyRequest(
        req,
        res,
        apiBase,
        payFetch,
        options,
        routerOpts2,
        deduplicator,
        balanceMonitor,
        sessionStore,
        responseCache,
        sessionJournal
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Proxy error: ${error.message}`, type: "proxy_error" }
          })
        );
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}

`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });
  const tryListen = (attempt) => {
    return new Promise((resolveAttempt, rejectAttempt) => {
      const onError = async (err) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE") {
          const existingWallet2 = await checkExistingProxy(listenPort);
          if (existingWallet2) {
            console.log(`[ClawRouter] Existing proxy detected on port ${listenPort}, reusing`);
            rejectAttempt({ code: "REUSE_EXISTING", wallet: existingWallet2 });
            return;
          }
          if (attempt < PORT_RETRY_ATTEMPTS) {
            console.log(
              `[ClawRouter] Port ${listenPort} in TIME_WAIT, retrying in ${PORT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PORT_RETRY_ATTEMPTS})`
            );
            rejectAttempt({ code: "RETRY", attempt });
            return;
          }
          console.error(
            `[ClawRouter] Port ${listenPort} still in use after ${PORT_RETRY_ATTEMPTS} attempts`
          );
          rejectAttempt(err);
          return;
        }
        rejectAttempt(err);
      };
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveAttempt();
      });
    });
  };
  let lastError;
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await tryListen(attempt);
      break;
    } catch (err) {
      const error = err;
      if (error.code === "REUSE_EXISTING" && error.wallet) {
        const baseUrl2 = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        return {
          port: listenPort,
          baseUrl: baseUrl2,
          walletAddress: error.wallet,
          balanceMonitor,
          close: async () => {
          }
        };
      }
      if (error.code === "RETRY") {
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }
      lastError = err;
      break;
    }
  }
  if (lastError) {
    throw lastError;
  }
  const addr = server.address();
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  options.onReady?.(port);
  checkForUpdates();
  server.on("error", (err) => {
    console.error(`[ClawRouter] Server runtime error: ${err.message}`);
    options.onError?.(err);
  });
  server.on("clientError", (err, socket) => {
    console.error(`[ClawRouter] Client error: ${err.message}`);
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.setTimeout(3e5);
    socket.on("timeout", () => {
      console.error(`[ClawRouter] Socket timeout, destroying connection`);
      socket.destroy();
    });
    socket.on("end", () => {
    });
    socket.on("error", (err) => {
      console.error(`[ClawRouter] Socket error: ${err.message}`);
    });
    socket.on("close", () => {
      connections.delete(socket);
    });
  });
  return {
    port,
    baseUrl,
    walletAddress: account.address,
    balanceMonitor,
    close: () => new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        rej(new Error("[ClawRouter] Close timeout after 4s"));
      }, 4e3);
      sessionStore.close();
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close((err) => {
        clearTimeout(timeout);
        if (err) {
          rej(err);
        } else {
          res();
        }
      });
    })
  };
}
async function tryModelRequest(upstreamUrl, method, headers, body, modelId, maxTokens, payFetch, balanceMonitor, signal) {
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString());
    parsed.model = modelId;
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages);
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = truncateMessages(parsed.messages);
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = sanitizeToolIds(parsed.messages);
    }
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages);
    }
    const hasThinkingEnabled = !!(parsed.thinking || parsed.extended_thinking || isReasoningModel(modelId));
    if (hasThinkingEnabled && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages);
    }
    requestBody = Buffer.from(JSON.stringify(parsed));
  } catch {
  }
  const estimated = estimateAmount(modelId, requestBody.length, maxTokens);
  const preAuth = estimated ? { estimatedAmount: estimated } : void 0;
  try {
    const response = await payFetch(
      upstreamUrl,
      {
        method,
        headers,
        body: requestBody.length > 0 ? new Uint8Array(requestBody) : void 0,
        signal
      },
      preAuth
    );
    if (response.status !== 200) {
      const errorBody = await response.text();
      const isProviderErr = isProviderError(response.status, errorBody);
      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderErr
      };
    }
    return { success: true, response };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorBody: errorMsg,
      errorStatus: 500,
      isProviderError: true
      // Network errors are retryable
    };
  }
}
async function proxyRequest(req, res, apiBase, payFetch, options, routerOpts2, deduplicator, balanceMonitor, sessionStore, responseCache, sessionJournal) {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);
  let routingDecision;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile = null;
  let accumulatedContent = "";
  const isChatCompletion = req.url?.includes("/chat/completions");
  const sessionId = getSessionId(req.headers);
  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString());
      isStreaming = parsed.stream === true;
      modelId = parsed.model || "";
      maxTokens = parsed.max_tokens || 4096;
      let bodyModified = false;
      if (sessionId && Array.isArray(parsed.messages)) {
        const messages = parsed.messages;
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const lastContent = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        if (sessionJournal.needsContext(lastContent)) {
          const journalText = sessionJournal.format(sessionId);
          if (journalText) {
            const sysIdx = messages.findIndex((m) => m.role === "system");
            if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
              messages[sysIdx] = {
                ...messages[sysIdx],
                content: journalText + "\n\n" + messages[sysIdx].content
              };
            } else {
              messages.unshift({ role: "system", content: journalText });
            }
            parsed.messages = messages;
            bodyModified = true;
            console.log(
              `[ClawRouter] Injected session journal (${journalText.length} chars) for session ${sessionId.slice(0, 8)}...`
            );
          }
        }
      }
      if (parsed.stream === true) {
        parsed.stream = false;
        bodyModified = true;
      }
      const normalizedModel = typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;
      const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel);
      if (isRoutingProfile) {
        const profileName = normalizedModel.replace("blockrun/", "");
        routingProfile = profileName;
      }
      console.log(
        `[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}${routingProfile ? `, profile: ${routingProfile}` : ""}`
      );
      if (wasAlias && !isRoutingProfile) {
        parsed.model = resolvedModel;
        modelId = resolvedModel;
        bodyModified = true;
      }
      if (isRoutingProfile) {
        if (routingProfile === "free") {
          const freeModel = "nvidia/gpt-oss-120b";
          console.log(`[ClawRouter] Free profile - using ${freeModel} directly`);
          parsed.model = freeModel;
          modelId = freeModel;
          bodyModified = true;
          await logUsage({
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            model: freeModel,
            tier: "SIMPLE",
            cost: 0,
            baselineCost: 0,
            savings: 1,
            // 100% savings
            latencyMs: 0
          });
        } else {
          const sessionId2 = getSessionId(
            req.headers
          );
          const existingSession = sessionId2 ? sessionStore.getSession(sessionId2) : void 0;
          if (existingSession) {
            console.log(
              `[ClawRouter] Session ${sessionId2?.slice(0, 8)}... using pinned model: ${existingSession.model}`
            );
            parsed.model = existingSession.model;
            modelId = existingSession.model;
            bodyModified = true;
            sessionStore.touchSession(sessionId2);
          } else {
            const messages = parsed.messages;
            let lastUserMsg;
            if (messages) {
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                  lastUserMsg = messages[i];
                  break;
                }
              }
            }
            const systemMsg = messages?.find((m) => m.role === "system");
            const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
            const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : void 0;
            const tools = parsed.tools;
            const hasTools = Array.isArray(tools) && tools.length > 0;
            if (hasTools) {
              console.log(
                `[ClawRouter] Tools detected (${tools.length}), agentic mode via keywords`
              );
            }
            routingDecision = route(prompt, systemPrompt, maxTokens, {
              ...routerOpts2,
              routingProfile: routingProfile ?? void 0
            });
            parsed.model = routingDecision.model;
            modelId = routingDecision.model;
            bodyModified = true;
            if (sessionId2) {
              sessionStore.setSession(sessionId2, routingDecision.model, routingDecision.tier);
              console.log(
                `[ClawRouter] Session ${sessionId2.slice(0, 8)}... pinned to model: ${routingDecision.model}`
              );
            }
            options.onRouted?.(routingDecision);
          }
        }
      }
      if (bodyModified) {
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }
  const autoCompress = options.autoCompressRequests ?? true;
  const compressionThreshold = options.compressionThresholdKB ?? 180;
  const requestSizeKB = Math.ceil(body.length / 1024);
  if (autoCompress && requestSizeKB > compressionThreshold) {
    try {
      console.log(
        `[ClawRouter] Request size ${requestSizeKB}KB exceeds threshold ${compressionThreshold}KB, applying compression...`
      );
      const parsed = JSON.parse(body.toString());
      if (parsed.messages && parsed.messages.length > 0 && shouldCompress(parsed.messages)) {
        const compressionResult = await compressContext(parsed.messages, {
          enabled: true,
          preserveRaw: false,
          // Don't need originals in proxy
          layers: {
            deduplication: true,
            // Safe: removes duplicate messages
            whitespace: true,
            // Safe: normalizes whitespace
            dictionary: false,
            // Disabled: requires model to understand codebook
            paths: false,
            // Disabled: requires model to understand path codes
            jsonCompact: true,
            // Safe: just removes JSON whitespace
            observation: false,
            // Disabled: may lose important context
            dynamicCodebook: false
            // Disabled: requires model to understand codes
          },
          dictionary: {
            maxEntries: 50,
            minPhraseLength: 15,
            includeCodebookHeader: false
          }
        });
        const compressedSizeKB = Math.ceil(compressionResult.compressedChars / 1024);
        const savings = ((requestSizeKB - compressedSizeKB) / requestSizeKB * 100).toFixed(1);
        console.log(
          `[ClawRouter] Compressed ${requestSizeKB}KB \u2192 ${compressedSizeKB}KB (${savings}% reduction)`
        );
        parsed.messages = compressionResult.messages;
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      console.warn(
        `[ClawRouter] Compression failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const cacheKey = ResponseCache.generateKey(body);
  const reqHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") reqHeaders[key] = value;
  }
  if (responseCache.shouldCache(body, reqHeaders)) {
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      console.log(`[ClawRouter] Cache HIT for ${cachedResponse.model} (saved API call)`);
      res.writeHead(cachedResponse.status, cachedResponse.headers);
      res.end(cachedResponse.body);
      return;
    }
  }
  const dedupKey = RequestDeduplicator.hash(body);
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  deduplicator.markInflight(dedupKey);
  let estimatedCostMicros;
  const isFreeModel = modelId === FREE_MODEL;
  if (modelId && !options.skipBalanceCheck && !isFreeModel) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);
      const bufferedCostMicros = estimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100)) / 100n;
      const sufficiency = await balanceMonitor.checkSufficient(bufferedCostMicros);
      if (sufficiency.info.isEmpty || !sufficiency.sufficient) {
        const originalModel = modelId;
        console.log(
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} ($${sufficiency.info.balanceUSD}), falling back to free model: ${FREE_MODEL} (requested: ${originalModel})`
        );
        modelId = FREE_MODEL;
        const parsed = JSON.parse(body.toString());
        parsed.model = FREE_MODEL;
        body = Buffer.from(JSON.stringify(parsed));
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress
        });
      } else if (sufficiency.info.isLow) {
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress
        });
      }
    }
  }
  let heartbeatInterval;
  let headersSentEarly = false;
  if (isStreaming) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    headersSentEarly = true;
    safeWrite(res, ": heartbeat\n\n");
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) {
        safeWrite(res, ": heartbeat\n\n");
      } else {
        clearInterval(heartbeatInterval);
        heartbeatInterval = void 0;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "transfer-encoding" || key === "content-length")
      continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  headers["user-agent"] = USER_AGENT;
  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    if (!completed) {
      deduplicator.removeInflight(dedupKey);
    }
  });
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let modelsToTry;
    if (routingDecision) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;
      const useAgenticTiers = routingDecision.reasoning?.includes("agentic") && routerOpts2.config.agenticTiers;
      const tierConfigs = useAgenticTiers ? routerOpts2.config.agenticTiers : routerOpts2.config.tiers;
      const fullChain = getFallbackChain(routingDecision.tier, tierConfigs);
      const contextFiltered = getFallbackChainFiltered(
        routingDecision.tier,
        tierConfigs,
        estimatedTotalTokens,
        getModelContextWindow
      );
      const contextExcluded = fullChain.filter((m) => !contextFiltered.includes(m));
      if (contextExcluded.length > 0) {
        console.log(
          `[ClawRouter] Context filter (~${estimatedTotalTokens} tokens): excluded ${contextExcluded.join(", ")}`
        );
      }
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      if (modelId && modelId !== FREE_MODEL) {
        modelsToTry = [modelId, FREE_MODEL];
      } else {
        modelsToTry = modelId ? [modelId] : [];
      }
    }
    let upstream;
    let lastError;
    let actualModelUsed = modelId;
    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;
      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);
      const result = await tryModelRequest(
        upstreamUrl,
        req.method ?? "POST",
        headers,
        body,
        tryModel,
        maxTokens,
        payFetch,
        balanceMonitor,
        controller.signal
      );
      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }
      lastError = {
        body: result.errorBody || "Unknown error",
        status: result.errorStatus || 500
      };
      if (result.isProviderError && !isLastAttempt) {
        if (result.errorStatus === 429) {
          markRateLimited(tryModel);
        }
        console.log(
          `[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`
        );
        continue;
      }
      if (!result.isProviderError) {
        console.log(
          `[ClawRouter] Non-provider error from ${tryModel}, not retrying: ${result.errorBody?.slice(0, 100)}`
        );
      }
      break;
    }
    clearTimeout(timeoutId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const newCosts = calculateModelCost(
        actualModelUsed,
        routerOpts2.modelPricing,
        estimatedInputTokens,
        maxTokens,
        routingProfile ?? void 0
      );
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
        costEstimate: newCosts.costEstimate,
        baselineCost: newCosts.baselineCost,
        savings: newCosts.savings
      };
      options.onRouted?.(routingDecision);
    }
    if (!upstream) {
      const rawErrBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;
      const transformedErr = transformPaymentError(rawErrBody);
      if (headersSentEarly) {
        let errPayload;
        try {
          const parsed = JSON.parse(transformedErr);
          errPayload = JSON.stringify(parsed);
        } catch {
          errPayload = JSON.stringify({
            error: { message: rawErrBody, type: "provider_error", status: errStatus }
          });
        }
        const errEvent = `data: ${errPayload}

`;
        safeWrite(res, errEvent);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
        const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: errBuf,
          completedAt: Date.now()
        });
      } else {
        res.writeHead(errStatus, { "Content-Type": "application/json" });
        res.end(transformedErr);
        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(transformedErr),
          completedAt: Date.now()
        });
      }
      return;
    }
    const responseChunks = [];
    if (headersSentEarly) {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const jsonBody = Buffer.concat(chunks);
        const jsonStr = jsonBody.toString();
        try {
          const rsp = JSON.parse(jsonStr);
          const baseChunk = {
            id: rsp.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: rsp.created ?? Math.floor(Date.now() / 1e3),
            model: rsp.model ?? "unknown",
            system_fingerprint: null
          };
          if (rsp.choices && Array.isArray(rsp.choices)) {
            for (const choice of rsp.choices) {
              const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
              const content = stripThinkingTokens(rawContent);
              const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
              const index = choice.index ?? 0;
              if (content) {
                accumulatedContent += content;
              }
              const roleChunk = {
                ...baseChunk,
                choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }]
              };
              const roleData = `data: ${JSON.stringify(roleChunk)}

`;
              safeWrite(res, roleData);
              responseChunks.push(Buffer.from(roleData));
              if (content) {
                const contentChunk = {
                  ...baseChunk,
                  choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }]
                };
                const contentData = `data: ${JSON.stringify(contentChunk)}

`;
                safeWrite(res, contentData);
                responseChunks.push(Buffer.from(contentData));
              }
              const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
              if (toolCalls && toolCalls.length > 0) {
                const toolCallChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index,
                      delta: { tool_calls: toolCalls },
                      logprobs: null,
                      finish_reason: null
                    }
                  ]
                };
                const toolCallData = `data: ${JSON.stringify(toolCallChunk)}

`;
                safeWrite(res, toolCallData);
                responseChunks.push(Buffer.from(toolCallData));
              }
              const finishChunk = {
                ...baseChunk,
                choices: [
                  {
                    index,
                    delta: {},
                    logprobs: null,
                    finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : choice.finish_reason ?? "stop"
                  }
                ]
              };
              const finishData = `data: ${JSON.stringify(finishChunk)}

`;
              safeWrite(res, finishData);
              responseChunks.push(Buffer.from(finishData));
            }
          }
        } catch {
          const sseData = `data: ${jsonStr}

`;
          safeWrite(res, sseData);
          responseChunks.push(Buffer.from(sseData));
        }
      }
      safeWrite(res, "data: [DONE]\n\n");
      responseChunks.push(Buffer.from("data: [DONE]\n\n"));
      res.end();
      deduplicator.complete(dedupKey, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.concat(responseChunks),
        completedAt: Date.now()
      });
    } else {
      const responseHeaders = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection" || key === "content-encoding")
          return;
        responseHeaders[key] = value;
      });
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            safeWrite(res, chunk);
            responseChunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      const responseBody = Buffer.concat(responseChunks);
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: responseBody,
        completedAt: Date.now()
      });
      if (upstream.status === 200 && responseCache.shouldCache(body)) {
        responseCache.set(cacheKey, {
          body: responseBody,
          status: upstream.status,
          headers: responseHeaders,
          model: modelId
        });
        console.log(`[ClawRouter] Cached response for ${modelId} (${responseBody.length} bytes)`);
      }
      try {
        const rspJson = JSON.parse(responseBody.toString());
        if (rspJson.choices?.[0]?.message?.content) {
          accumulatedContent = rspJson.choices[0].message.content;
        }
      } catch {
      }
    }
    if (sessionId && accumulatedContent) {
      const events = sessionJournal.extractEvents(accumulatedContent);
      if (events.length > 0) {
        sessionJournal.record(sessionId, events, actualModelUsed);
        console.log(
          `[ClawRouter] Recorded ${events.length} events to session journal for session ${sessionId.slice(0, 8)}...`
        );
      }
    }
    if (estimatedCostMicros !== void 0) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }
    completed = true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    deduplicator.removeInflight(dedupKey);
    balanceMonitor.invalidate();
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (routingDecision) {
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const accurateCosts = calculateModelCost(
      routingDecision.model,
      routerOpts2.modelPricing,
      estimatedInputTokens,
      maxTokens,
      routingProfile ?? void 0
    );
    const costWithBuffer = accurateCosts.costEstimate * 1.2;
    const baselineWithBuffer = accurateCosts.baselineCost * 1.2;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      model: routingDecision.model,
      tier: routingDecision.tier,
      cost: costWithBuffer,
      baselineCost: baselineWithBuffer,
      savings: accurateCosts.savings,
      latencyMs: Date.now() - startTime
    };
    logUsage(entry).catch(() => {
    });
  }
}

// test/e2e.ts
function buildModelPricing2() {
  const map = /* @__PURE__ */ new Map();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === "blockrun/auto") continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}
var passed = 0;
var failed = 0;
function assert(condition, msg) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${msg}`);
    failed++;
  }
}
console.log("\n\u2550\u2550\u2550 Part 1: Rule-Based Classifier \u2550\u2550\u2550\n");
var config = DEFAULT_ROUTING_CONFIG;
{
  console.log("Simple queries:");
  const r1 = classifyByRules("What is the capital of France?", void 0, 8, config.scoring);
  assert(
    r1.tier === "SIMPLE",
    `"What is the capital of France?" \u2192 ${r1.tier} (score=${r1.score.toFixed(3)})`
  );
  const r2 = classifyByRules("Hello", void 0, 2, config.scoring);
  assert(r2.tier === "SIMPLE", `"Hello" \u2192 ${r2.tier} (score=${r2.score.toFixed(3)})`);
  const r3 = classifyByRules("Define photosynthesis", void 0, 4, config.scoring);
  assert(
    r3.tier === "SIMPLE" || r3.tier === "MEDIUM" || r3.tier === null,
    `"Define photosynthesis" \u2192 ${r3.tier} (score=${r3.score.toFixed(3)})`
  );
  const r4 = classifyByRules("Translate hello to Spanish", void 0, 6, config.scoring);
  assert(
    r4.tier === "SIMPLE",
    `"Translate hello to Spanish" \u2192 ${r4.tier} (score=${r4.score.toFixed(3)})`
  );
  const r5 = classifyByRules("Yes or no: is the sky blue?", void 0, 8, config.scoring);
  assert(
    r5.tier === "SIMPLE",
    `"Yes or no: is the sky blue?" \u2192 ${r5.tier} (score=${r5.score.toFixed(3)})`
  );
}
{
  console.log("\nSystem prompt with reasoning keywords (should NOT affect simple queries):");
  const systemPrompt = "Think step by step and reason logically about the user's question.";
  const r1 = classifyByRules("What is 2+2?", systemPrompt, 10, config.scoring);
  assert(
    r1.tier === "SIMPLE",
    `"2+2" with reasoning system prompt \u2192 ${r1.tier} (should be SIMPLE)`
  );
  const r2 = classifyByRules("Hello", systemPrompt, 5, config.scoring);
  assert(
    r2.tier === "SIMPLE",
    `"Hello" with reasoning system prompt \u2192 ${r2.tier} (should be SIMPLE)`
  );
  const r3 = classifyByRules("What is the capital of France?", systemPrompt, 12, config.scoring);
  assert(
    r3.tier === "SIMPLE",
    `"Capital of France" with reasoning system prompt \u2192 ${r3.tier} (should be SIMPLE)`
  );
  const r4 = classifyByRules(
    "Prove step by step that sqrt(2) is irrational",
    systemPrompt,
    50,
    config.scoring
  );
  assert(
    r4.tier === "REASONING",
    `User asks for step-by-step proof \u2192 ${r4.tier} (should be REASONING)`
  );
}
{
  console.log("\nMedium/Ambiguous queries:");
  const r1 = classifyByRules(
    "Summarize the key differences between REST and GraphQL APIs",
    void 0,
    30,
    config.scoring
  );
  console.log(
    `  \u2192 "Summarize REST vs GraphQL" \u2192 tier=${r1.tier ?? "AMBIGUOUS"} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)}) [${r1.signals.join(", ")}]`
  );
  const r2 = classifyByRules(
    "Write a Python function to sort a list using merge sort",
    void 0,
    40,
    config.scoring
  );
  console.log(
    `  \u2192 "Write merge sort" \u2192 tier=${r2.tier ?? "AMBIGUOUS"} (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)}) [${r2.signals.join(", ")}]`
  );
}
{
  console.log("\nComplex queries (expected: ambiguous \u2192 fallback classifier):");
  const r1 = classifyByRules(
    "Build a React component with TypeScript that implements a drag-and-drop kanban board with async data loading, error handling, and unit tests",
    void 0,
    200,
    config.scoring
  );
  assert(
    r1.tier === null,
    `Kanban board \u2192 AMBIGUOUS (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)}) \u2014 correctly defers to classifier`
  );
  const r2 = classifyByRules(
    "Design a distributed microservice architecture for a real-time trading platform. Include the database schema, API endpoints, message queue topology, and kubernetes deployment manifests.",
    void 0,
    250,
    config.scoring
  );
  assert(
    r2.tier === null,
    `Distributed trading platform \u2192 AMBIGUOUS (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)}) \u2014 correctly defers to classifier`
  );
}
{
  console.log("\nReasoning queries:");
  const r1 = classifyByRules(
    "Prove that the square root of 2 is irrational using proof by contradiction. Show each step formally.",
    void 0,
    60,
    config.scoring
  );
  assert(
    r1.tier === "REASONING",
    `"Prove sqrt(2) irrational" \u2192 ${r1.tier} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)})`
  );
  const r2 = classifyByRules(
    "Derive the time complexity of the following algorithm step by step, then prove it is optimal using a lower bound argument.",
    void 0,
    80,
    config.scoring
  );
  assert(
    r2.tier === "REASONING",
    `"Derive time complexity + prove optimal" \u2192 ${r2.tier} (score=${r2.score.toFixed(3)}, conf=${r2.confidence.toFixed(3)})`
  );
  const r3 = classifyByRules(
    "Using chain of thought, solve this mathematical proof: for all n >= 1, prove that 1 + 2 + ... + n = n(n+1)/2",
    void 0,
    70,
    config.scoring
  );
  assert(
    r3.tier === "REASONING",
    `"Chain of thought proof" \u2192 ${r3.tier} (score=${r3.score.toFixed(3)}, conf=${r3.confidence.toFixed(3)})`
  );
}
{
  console.log("\nMultilingual keyword tests:");
  const zhReasoning = classifyByRules(
    "\u8BF7\u8BC1\u660E\u6839\u53F72\u662F\u65E0\u7406\u6570\uFF0C\u9010\u6B65\u63A8\u5BFC",
    void 0,
    20,
    config.scoring
  );
  assert(
    zhReasoning.tier === "REASONING",
    `Chinese "\u8BC1\u660E...\u9010\u6B65" \u2192 ${zhReasoning.tier} (should be REASONING)`
  );
  const zhSimple = classifyByRules("\u4F60\u597D\uFF0C\u4EC0\u4E48\u662F\u4EBA\u5DE5\u667A\u80FD\uFF1F", void 0, 15, config.scoring);
  assert(
    zhSimple.tier === "SIMPLE",
    `Chinese "\u4F60\u597D...\u4EC0\u4E48\u662F" \u2192 ${zhSimple.tier} (should be SIMPLE)`
  );
  const jaSimple = classifyByRules("\u3053\u3093\u306B\u3061\u306F\u3001\u6771\u4EAC\u3068\u306F\u4F55\u3067\u3059\u304B", void 0, 15, config.scoring);
  assert(
    jaSimple.tier === "SIMPLE",
    `Japanese "\u3053\u3093\u306B\u3061\u306F...\u3068\u306F" \u2192 ${jaSimple.tier} (should be SIMPLE)`
  );
  const ruTech = classifyByRules(
    "\u041E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C \u0441\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u043A\u0438 \u0434\u043B\u044F \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u043E\u0439 \u0441\u0438\u0441\u0442\u0435\u043C\u044B",
    void 0,
    20,
    config.scoring
  );
  assert(
    ruTech.tier !== "SIMPLE",
    `Russian "\u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C...\u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u043E\u0439" \u2192 ${ruTech.tier} (should NOT be SIMPLE)`
  );
  const ruSimple = classifyByRules(
    "\u041F\u0440\u0438\u0432\u0435\u0442, \u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435 \u043C\u0430\u0448\u0438\u043D\u043D\u043E\u0435 \u043E\u0431\u0443\u0447\u0435\u043D\u0438\u0435?",
    void 0,
    15,
    config.scoring
  );
  assert(
    ruSimple.tier === "SIMPLE",
    `Russian "\u043F\u0440\u0438\u0432\u0435\u0442...\u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435" \u2192 ${ruSimple.tier} (should be SIMPLE)`
  );
  const deReasoning = classifyByRules(
    "Beweisen Sie, dass die Quadratwurzel von 2 irrational ist, Schritt f\xFCr Schritt",
    void 0,
    25,
    config.scoring
  );
  assert(
    deReasoning.tier === "REASONING",
    `German "beweisen...schritt f\xFCr schritt" \u2192 ${deReasoning.tier} (should be REASONING)`
  );
  const deSimple = classifyByRules(
    "Hallo, was ist maschinelles Lernen?",
    void 0,
    10,
    config.scoring
  );
  assert(
    deSimple.tier === "SIMPLE",
    `German "hallo...was ist" \u2192 ${deSimple.tier} (should be SIMPLE)`
  );
  const deTech = classifyByRules(
    "Optimieren Sie den Sortieralgorithmus f\xFCr eine verteilte Architektur",
    void 0,
    20,
    config.scoring
  );
  assert(
    deTech.tier !== "SIMPLE",
    `German "algorithmus...verteilt" \u2192 ${deTech.tier} (should NOT be SIMPLE)`
  );
}
{
  console.log("\nOverride: large context:");
  const r1 = classifyByRules("What is 2+2?", void 0, 15e4, config.scoring);
  console.log(
    `  \u2192 150K tokens "What is 2+2?" \u2192 tier=${r1.tier ?? "AMBIGUOUS"} (score=${r1.score.toFixed(3)}, conf=${r1.confidence.toFixed(3)})`
  );
}
console.log("\n\u2550\u2550\u2550 Part 2: Full Router (rules-only path) \u2550\u2550\u2550\n");
var modelPricing = buildModelPricing2();
var mockPayFetch = async () => new Response("", { status: 500 });
var routerOpts = {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
  payFetch: mockPayFetch,
  apiBase: "http://localhost:0"
};
async function testRoute(prompt, label, expectedTier) {
  const decision = await route(prompt, void 0, 4096, routerOpts);
  const savingsPct = (decision.savings * 100).toFixed(1);
  if (expectedTier) {
    assert(
      decision.tier === expectedTier,
      `${label} \u2192 ${decision.model} (${decision.tier}, ${decision.method}) saved=${savingsPct}%`
    );
  } else {
    console.log(
      `  \u2192 ${label} \u2192 ${decision.model} (${decision.tier}, ${decision.method}) saved=${savingsPct}%`
    );
  }
  return decision;
}
await testRoute("What is the capital of France?", "Simple factual", "SIMPLE");
await testRoute("Hello, how are you?", "Greeting", "SIMPLE");
await testRoute(
  "Prove that sqrt(2) is irrational step by step using proof by contradiction",
  "Math proof",
  "REASONING"
);
{
  const longPrompt = "x".repeat(5e5);
  const decision = await route(longPrompt, void 0, 4096, routerOpts);
  assert(
    decision.tier === "COMPLEX",
    `125K token input \u2192 ${decision.tier} (forced COMPLEX override)`
  );
}
{
  const decision = await route(
    "What is 2+2?",
    "Respond in JSON format with the answer",
    4096,
    routerOpts
  );
  assert(
    decision.tier === "MEDIUM" || decision.tier === "SIMPLE",
    `Structured output "What is 2+2?" \u2192 ${decision.tier} (min MEDIUM applied: ${decision.tier !== "SIMPLE"})`
  );
}
{
  console.log("\nCost estimate sanity:");
  const d = await route("What is 2+2?", void 0, 4096, routerOpts);
  assert(d.costEstimate > 0, `Cost estimate > 0: $${d.costEstimate.toFixed(6)}`);
  assert(d.baselineCost > 0, `Baseline cost > 0: $${d.baselineCost.toFixed(6)}`);
  assert(d.savings >= 0 && d.savings <= 1, `Savings in range [0,1]: ${d.savings.toFixed(4)}`);
  assert(
    d.costEstimate <= d.baselineCost,
    `Cost ($${d.costEstimate.toFixed(6)}) <= Baseline ($${d.baselineCost.toFixed(6)})`
  );
}
console.log("\n\u2550\u2550\u2550 Part 3: Proxy Startup \u2550\u2550\u2550\n");
var walletKey = process.env.BLOCKRUN_WALLET_KEY;
if (!walletKey) {
  console.log("  Skipped \u2014 set BLOCKRUN_WALLET_KEY to test proxy startup\n");
} else {
  try {
    const proxy = await startProxy({
      walletKey,
      port: 0,
      onReady: (port) => console.log(`  Proxy started on port ${port}`),
      onError: (err) => console.error(`  Proxy error: ${err.message}`),
      onRouted: (d) => {
        const pct = (d.savings * 100).toFixed(1);
        console.log(`  [routed] ${d.model} (${d.tier}) saved=${pct}%`);
      }
    });
    const health = await fetch(`${proxy.baseUrl}/health`);
    const healthData = await health.json();
    assert(
      healthData.status === "ok",
      `Health check: ${healthData.status}, wallet: ${healthData.wallet}`
    );
    console.log("\n  Sending test request (blockrun/auto)...");
    try {
      const chatRes = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "blockrun/auto",
          messages: [{ role: "user", content: "What is 2+2?" }],
          max_tokens: 50
        })
      });
      if (chatRes.ok) {
        const chatData = await chatRes.json();
        const content = chatData.choices?.[0]?.message?.content ?? "(no content)";
        console.log(`  \u2713 Response: ${content.slice(0, 100)}`);
        passed++;
      } else {
        const errText = await chatRes.text();
        console.log(`  Response status: ${chatRes.status} \u2014 ${errText.slice(0, 200)}`);
        if (chatRes.status === 402) {
          console.log("  (402 = wallet needs USDC funding \u2014 routing still worked)");
        }
      }
    } catch (err) {
      console.log(`  Request error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await proxy.close();
    console.log("  Proxy closed.\n");
  } catch (err) {
    console.error(`  Proxy startup failed: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
process.exit(failed > 0 ? 1 : 0);
//# sourceMappingURL=e2e.js.map