/**
 * Lionheart Custom Routing Config
 *
 * Local-first routing: uses free local models for simple/medium tasks,
 * Claude subscription for complex/reasoning, DeepSeek as cheap cloud fallback.
 *
 * Backends (via CLI proxy at 127.0.0.1:11435):
 *   - EXO (localhost:52415)      → Llama 3.1 8B on Apple Silicon ($0)
 *   - Ollama (daddyo-gaming)     → Qwen3 14B on RTX 3080 ($0, native tool calling)
 *   - Claude CLI (subscription)  → Sonnet/Opus via `claude --print`
 *   - DeepSeek API               → deepseek-chat / deepseek-reasoner (pay-per-token)
 *
 * Model ID convention (matches CLI proxy routing):
 *   local/exo-llama-8b       → EXO Llama 3.1 8B
 *   local/ollama-qwen3-14b   → Ollama Qwen3 14B (CUDA, tool calling)
 *   local/exo-llama-3b       → EXO Llama 3.2 3B (fast)
 *   claude-cli/sonnet         → Claude Sonnet 4.5 (subscription)
 *   claude-cli/opus           → Claude Opus 4.6 (subscription)
 *   deepseek/deepseek-chat    → DeepSeek V3 ($0.14/$0.28 per M tokens)
 *   deepseek/deepseek-reasoner → DeepSeek R1 ($0.55/$2.19 per M tokens)
 */

import type { RoutingConfig } from "./types.js";
import { DEFAULT_ROUTING_CONFIG } from "./config.js";

export const LIONHEART_ROUTING_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,

  tiers: {
    // SIMPLE: greetings, definitions, translations, yes/no questions
    // → Free local model, fast response, no quota burn
    SIMPLE: {
      primary: "local/exo-llama-8b",
      fallback: [
        "local/ollama-qwen3-14b",
        "deepseek/deepseek-chat",
        "claude-cli/sonnet",
      ],
    },

    // MEDIUM: code tasks, technical questions, multi-step instructions
    // → Ollama Qwen3 14B handles this well with native tool calling
    MEDIUM: {
      primary: "local/ollama-qwen3-14b",
      fallback: [
        "deepseek/deepseek-chat",
        "claude-cli/sonnet",
        "local/exo-llama-8b",
      ],
    },

    // COMPLEX: architecture design, complex analysis, long-context tasks
    // → Claude Sonnet via subscription (no per-token cost)
    COMPLEX: {
      primary: "claude-cli/sonnet",
      fallback: [
        "deepseek/deepseek-chat",
        "claude-cli/opus",
        "local/ollama-qwen3-14b",
      ],
    },

    // REASONING: proofs, formal derivation, chain-of-thought, math
    // → Claude Opus for best reasoning, DeepSeek Reasoner as cheap fallback
    REASONING: {
      primary: "claude-cli/opus",
      fallback: [
        "deepseek/deepseek-reasoner",
        "claude-cli/sonnet",
      ],
    },
  },

  // Agentic tiers: models with strong tool calling for multi-step tasks
  // Key: Ollama Qwen3 14B has native OpenAI tool calling (0.971 F1)
  agenticTiers: {
    SIMPLE: {
      primary: "local/ollama-qwen3-14b",  // Native tool calling, $0
      fallback: [
        "deepseek/deepseek-chat",
        "claude-cli/sonnet",
      ],
    },
    MEDIUM: {
      primary: "local/ollama-qwen3-14b",  // Strong tool calling for coding
      fallback: [
        "claude-cli/sonnet",
        "deepseek/deepseek-chat",
      ],
    },
    COMPLEX: {
      primary: "claude-cli/sonnet",
      fallback: [
        "claude-cli/opus",
        "deepseek/deepseek-chat",
        "local/ollama-qwen3-14b",
      ],
    },
    REASONING: {
      primary: "claude-cli/opus",
      fallback: [
        "deepseek/deepseek-reasoner",
        "claude-cli/sonnet",
      ],
    },
  },

  overrides: {
    ...DEFAULT_ROUTING_CONFIG.overrides,
    // Lower threshold since local models have small context windows
    maxTokensForceComplex: 8_000,
    // Default ambiguous to MEDIUM (routes to Ollama, free)
    ambiguousDefaultTier: "MEDIUM",
  },
};

/**
 * Model pricing for cost estimation and savings calculation.
 * Local models are $0. Claude CLI is subscription (treat as $0 marginal cost).
 * Only DeepSeek has real per-token costs.
 */
export const LIONHEART_MODEL_PRICING = new Map([
  // Local models — $0
  ["local/exo-llama-8b", { inputPrice: 0, outputPrice: 0 }],
  ["local/exo-llama-3b", { inputPrice: 0, outputPrice: 0 }],
  ["local/ollama-qwen3-14b", { inputPrice: 0, outputPrice: 0 }],

  // Claude CLI — subscription, no marginal cost per token
  ["claude-cli/sonnet", { inputPrice: 0, outputPrice: 0 }],
  ["claude-cli/opus", { inputPrice: 0, outputPrice: 0 }],

  // DeepSeek — pay-per-token (prices in $ per 1M tokens)
  ["deepseek/deepseek-chat", { inputPrice: 0.14, outputPrice: 0.28 }],
  ["deepseek/deepseek-reasoner", { inputPrice: 0.55, outputPrice: 2.19 }],

  // Baseline for savings comparison (Opus API pricing)
  ["anthropic/claude-opus-4", { inputPrice: 15.0, outputPrice: 75.0 }],
]);
