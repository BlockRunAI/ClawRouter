/**
 * Smart Router Types
 *
 * Four classification tiers — REASONING is distinct from COMPLEX because
 * reasoning tasks need different models (o3, gemini-pro) than general
 * complex tasks (gpt-4o, sonnet-4).
 *
 * Scoring uses weighted float dimensions with sigmoid confidence calibration.
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export type ScoringResult = {
  score: number; // weighted float (roughly [-0.3, 0.4])
  tier: Tier | null; // null = ambiguous, needs fallback classifier
  confidence: number; // sigmoid-calibrated [0, 1]
  signals: string[];
  agenticScore?: number; // 0-1 agentic task score for auto-switching to agentic tiers
};

export type RoutingDecision = {
  model: string;
  tier: Tier;
  confidence: number;
  method: "rules" | "llm";
  reasoning: string;
  costEstimate: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
};

export type TierConfig = {
  primary: string;
  fallback: string[];
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
  // New dimension keyword lists
  imperativeVerbs: string[];
  constraintIndicators: string[];
  outputFormatKeywords: string[];
  referenceKeywords: string[];
  negationKeywords: string[];
  domainSpecificKeywords: string[];
  // Agentic task detection keywords
  agenticTaskKeywords: string[];
  // Weighted scoring parameters
  dimensionWeights: Record<string, number>;
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
    complexReasoning: number;
  };
  confidenceSteepness: number;
  confidenceThreshold: number;
};

export type ClassifierConfig = {
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  promptTruncationChars: number;
  cacheTtlMs: number;
};

export type OverridesConfig = {
  maxTokensForceComplex: number;
  structuredOutputMinTier: Tier;
  ambiguousDefaultTier: Tier;
  /**
   * When enabled, prefer models optimized for agentic workflows.
   * Agentic models continue autonomously with multi-step tasks
   * instead of stopping and waiting for user input.
   */
  agenticMode?: boolean;
};

export type RoutingConfig = {
  version: string;
  classifier: ClassifierConfig;
  scoring: ScoringConfig;
  tiers: Record<Tier, TierConfig>;
  /** Tier configs for agentic mode - models that excel at multi-step tasks */
  agenticTiers?: Record<Tier, TierConfig>;
  /** Tier configs for eco profile - ultra cost-optimized (blockrun/eco) */
  ecoTiers?: Record<Tier, TierConfig>;
  /** Tier configs for premium profile - best quality (blockrun/premium) */
  premiumTiers?: Record<Tier, TierConfig>;
  overrides: OverridesConfig;
};
