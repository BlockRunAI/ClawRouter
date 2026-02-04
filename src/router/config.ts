/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 *
 * Scoring uses 14 weighted dimensions with sigmoid confidence calibration.
 */

import type { RoutingConfig } from "./types.js";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "2.0",

  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3_600_000, // 1 hour
  },

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    codeKeywords: [
      "function", "class", "import", "def", "SELECT", "async", "await",
      "const", "let", "var", "return", "```",
    ],
    reasoningKeywords: [
      "prove", "theorem", "derive", "step by step", "chain of thought",
      "formally", "mathematical", "proof", "logically",
    ],
    simpleKeywords: [
      "what is", "define", "translate", "hello", "yes or no",
      "capital of", "how old", "who is", "when was",
    ],
    technicalKeywords: [
      "algorithm", "optimize", "architecture", "distributed",
      "kubernetes", "microservice", "database", "infrastructure",
    ],
    creativeKeywords: [
      "story", "poem", "compose", "brainstorm", "creative",
      "imagine", "write a",
    ],

    // New dimension keyword lists
    imperativeVerbs: [
      "build", "create", "implement", "design", "develop", "construct",
      "generate", "deploy", "configure", "set up",
    ],
    constraintIndicators: [
      "under", "at most", "at least", "within", "no more than",
      "o(", "maximum", "minimum", "limit", "budget",
    ],
    outputFormatKeywords: [
      "json", "yaml", "xml", "table", "csv", "markdown",
      "schema", "format as", "structured",
    ],
    referenceKeywords: [
      "above", "below", "previous", "following", "the docs",
      "the api", "the code", "earlier", "attached",
    ],
    negationKeywords: [
      "don't", "do not", "avoid", "never", "without",
      "except", "exclude", "no longer",
    ],
    domainSpecificKeywords: [
      "quantum", "fpga", "vlsi", "risc-v", "asic", "photonics",
      "genomics", "proteomics", "topological", "homomorphic",
      "zero-knowledge", "lattice-based",
    ],

    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.10,
      creativeMarkers: 0.05,
      simpleIndicators: 0.12,
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
    },

    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0.0,
      mediumComplex: 0.15,
      complexReasoning: 0.25,
    },

    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.70,
  },

  tiers: {
    SIMPLE: {
      primary: "google/gemini-2.5-flash",
      fallback: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat",
      fallback: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4",
      fallback: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
    },
    REASONING: {
      primary: "openai/o3",
      fallback: ["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"],
    },
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    structuredOutputMinTier: "MEDIUM",
  },
};
