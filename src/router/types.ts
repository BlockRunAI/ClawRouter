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
  dimensions?: Array<{ name: string; score: number; signal: string | null }>; // per-dimension breakdown for /debug
};

export type RoutingDecision = {
  model: string;
  tier: Tier;
  confidence: number;
  method: "rules" | "llm" | "portfolio";
  reasoning: string;
  costEstimate: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
  agenticScore?: number; // 0-1 agentic task score (present when tier routing used)
  /** Which tier configs were used (auto/eco/premium/agentic) — avoids re-derivation in proxy */
  tierConfigs?: Record<Tier, TierConfig>;
  /** Which routing profile was applied */
  profile?: "auto" | "eco" | "premium" | "agentic";
  /** Ordered, capability-eligible candidates. The first entry is `model`. */
  candidates?: string[];
  /** Explainable request classification used by the portfolio router. */
  taskType?: TaskType;
  /** Router implementation that made the selection. */
  routerVersion?: "v2-rules" | "v3-portfolio";
  /** Explainable local portfolio score breakdown, ordered with `candidates`. */
  candidateScores?: Array<{
    model: string;
    score: number;
    quality: number;
    cost: number;
    speed: number;
    reliability: number;
  }>;
};

export type TaskType =
  | "chat"
  | "extraction"
  | "code_edit"
  | "code_agent"
  | "tool_agent"
  | "tool_agent_parallel"
  | "debug"
  | "reasoning"
  | "reasoning_mcq"
  | "reasoning_math"
  | "long_context"
  | "vision";

export interface RouterStrategy {
  readonly name: string;
  route(
    prompt: string,
    systemPrompt: string | undefined,
    maxOutputTokens: number,
    options: RouterOptions,
  ): RoutingDecision;
}

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing: Map<string, import("./selector.js").ModelPricing>;
  routingProfile?: "eco" | "auto" | "premium";
  hasTools?: boolean;
  /** Number of tool definitions visible to the model on this turn. */
  toolCount?: number;
  /** Local tool identifiers, used only for request/tool intent matching. */
  toolNames?: readonly string[];
  /** Tools are attached by the host and this specific turn needs to use them. */
  requiresTools?: boolean;
  hasVision?: boolean;
  /** OpenAI `response_format` / JSON schema requires reliable structured output. */
  requiresStructuredOutput?: boolean;
  /** Override current time for promotion window checks (for testing). Default: new Date() */
  now?: Date;
  /**
   * Fresh gateway performance observations. Injected rather than fetched on
   * the hot path; omitted entries fall back to a weak historical prior.
   */
  modelPerformance?: Readonly<
    Record<string, import("./model-profiles.js").ModelPerformanceProfile>
  >;
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

/**
 * Time-windowed promotion that temporarily overrides tier routing.
 * Active promotions are auto-applied; expired ones are ignored at runtime.
 */
export type Promotion = {
  /** Human-readable label (e.g. "GLM-5 Launch Promo") */
  name: string;
  /** ISO date string, promotion starts (inclusive). e.g. "2026-04-01" */
  startDate: string;
  /** ISO date string, promotion ends (exclusive). e.g. "2026-04-15" */
  endDate: string;
  /** Partial tier overrides — merged into the active tier configs (primary/fallback) */
  tierOverrides: Partial<Record<Tier, Partial<TierConfig>>>;
  /** Which profiles this applies to. Default: all profiles. */
  profiles?: Array<"auto" | "eco" | "premium" | "agentic">;
};

export type RoutingConfig = {
  version: string;
  /** Enables a one-line rollback to the established V2 rules selector. */
  strategy?: "rules" | "portfolio";
  /**
   * Locally recompute a comparison strategy without changing the model that
   * actually serves the request. The proxy emits only decision metadata via
   * `onShadowRouted`; it never persists prompt content or makes a second call.
   */
  shadow?: { strategy: "rules" | "portfolio"; sampleRate?: number };
  /** Calibratable local portfolio scoring weights; values are relative, not probabilities. */
  portfolio?: {
    auto: {
      quality: number;
      capability: number;
      cost: number;
      speed: number;
      reliability: number;
      legacy: number;
    };
    eco: {
      quality: number;
      capability: number;
      cost: number;
      speed: number;
      reliability: number;
      legacy: number;
    };
    premium: {
      quality: number;
      capability: number;
      cost: number;
      speed: number;
      reliability: number;
      legacy: number;
    };
    highStakesBoost: { quality: number; reliability: number };
    latencySensitiveSpeedBoost: number;
    /** A candidate materially below the best task affinity cannot win on cost alone. */
    affinityFloorGap: { auto: number; eco: number; premium: number };
  };
  classifier: ClassifierConfig;
  scoring: ScoringConfig;
  tiers: Record<Tier, TierConfig>;
  /**
   * Tier configs for agentic mode — models that excel at multi-step tasks.
   * Set to `null` to disable agentic tier selection entirely (forces all
   * requests through `tiers`, even when tools are present in the request).
   */
  agenticTiers?: Record<Tier, TierConfig> | null;
  /** Tier configs for eco profile — ultra cost-optimized (blockrun/eco). `null` falls back to `tiers`. */
  ecoTiers?: Record<Tier, TierConfig> | null;
  /** Tier configs for premium profile — best quality (blockrun/premium). `null` falls back to `tiers`. */
  premiumTiers?: Record<Tier, TierConfig> | null;
  /** Time-windowed promotions that temporarily override tier routing */
  promotions?: Promotion[];
  overrides: OverridesConfig;
};
