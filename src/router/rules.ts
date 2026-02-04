/**
 * Rule-Based Classifier (v2 — Weighted Scoring)
 *
 * Scores a request across 14 weighted dimensions and maps the aggregate
 * score to a tier using configurable boundaries. Confidence is calibrated
 * via sigmoid — low confidence triggers the fallback classifier.
 *
 * Handles 70-80% of requests in < 1ms with zero cost.
 */

import type { Tier, ScoringResult, ScoringConfig } from "./types.js";

type DimensionScore = { name: string; score: number; signal: string | null };

// ─── Dimension Scorers ───
// Each returns a score in [-1, 1] and an optional signal string.

function scoreTokenCount(
  estimatedTokens: number,
  thresholds: { simple: number; complex: number },
): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1.0, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1.0, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  keywords: string[],
  name: string,
  signalLabel: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number },
): DimensionScore {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return { name, score: scores.high, signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})` };
  }
  if (matches.length >= thresholds.low) {
    return { name, score: scores.low, signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})` };
  }
  return { name, score: scores.none, signal: null };
}

function scoreMultiStep(text: string): DimensionScore {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}

function scoreQuestionComplexity(prompt: string): DimensionScore {
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}

// ─── Main Classifier ───

export function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  estimatedTokens: number,
  config: ScoringConfig,
): ScoringResult {
  const text = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();

  // Score all 14 dimensions
  const dimensions: DimensionScore[] = [
    // Original 8 dimensions
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(text, config.codeKeywords, "codePresence", "code",
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 1.0 }),
    scoreKeywordMatch(text, config.reasoningKeywords, "reasoningMarkers", "reasoning",
      { low: 1, high: 2 }, { none: 0, low: 0.7, high: 1.0 }),
    scoreKeywordMatch(text, config.technicalKeywords, "technicalTerms", "technical",
      { low: 2, high: 4 }, { none: 0, low: 0.5, high: 1.0 }),
    scoreKeywordMatch(text, config.creativeKeywords, "creativeMarkers", "creative",
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.7 }),
    scoreKeywordMatch(text, config.simpleKeywords, "simpleIndicators", "simple",
      { low: 1, high: 2 }, { none: 0, low: -1.0, high: -1.0 }),
    scoreMultiStep(text),
    scoreQuestionComplexity(prompt),

    // 6 new dimensions
    scoreKeywordMatch(text, config.imperativeVerbs, "imperativeVerbs", "imperative",
      { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(text, config.constraintIndicators, "constraintCount", "constraints",
      { low: 1, high: 3 }, { none: 0, low: 0.3, high: 0.7 }),
    scoreKeywordMatch(text, config.outputFormatKeywords, "outputFormat", "format",
      { low: 1, high: 2 }, { none: 0, low: 0.4, high: 0.7 }),
    scoreKeywordMatch(text, config.referenceKeywords, "referenceComplexity", "references",
      { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(text, config.negationKeywords, "negationComplexity", "negation",
      { low: 2, high: 3 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(text, config.domainSpecificKeywords, "domainSpecificity", "domain-specific",
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.8 }),
  ];

  // Collect signals
  const signals = dimensions
    .filter((d) => d.signal !== null)
    .map((d) => d.signal!);

  // Compute weighted score
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }

  // Count reasoning markers for override
  const reasoningMatches = config.reasoningKeywords.filter((kw) =>
    text.includes(kw.toLowerCase()),
  );

  // Direct reasoning override: 2+ reasoning markers = high confidence REASONING
  if (reasoningMatches.length >= 2) {
    const confidence = calibrateConfidence(
      Math.max(weightedScore, 0.3), // ensure positive for confidence calc
      config.confidenceSteepness,
    );
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence, 0.85),
      signals,
    };
  }

  // Map weighted score to tier using boundaries
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier: Tier;
  let distanceFromBoundary: number;

  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(
      weightedScore - simpleMedium,
      mediumComplex - weightedScore,
    );
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore,
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }

  // Calibrate confidence via sigmoid of distance from nearest boundary
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);

  // If confidence is below threshold → ambiguous
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals };
  }

  return { score: weightedScore, tier, confidence, signals };
}

/**
 * Sigmoid confidence calibration.
 * Maps distance from tier boundary to [0.5, 1.0] confidence range.
 */
function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}
