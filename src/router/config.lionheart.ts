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
 *   - Codex CLI (subscription)   → GPT-5.3 Codex / o3 via `codex --full-auto`
 *   - DeepSeek API               → deepseek-chat / deepseek-reasoner (pay-per-token)
 *
 * Fallback priority: local($0) → subscription($0 marginal) → cloud(per-token)
 * When hitting Claude weekly limits, Codex is tried before DeepSeek.
 *
 * Model ID convention (matches CLI proxy routing):
 *   local/exo-llama-8b       → EXO Llama 3.1 8B
 *   local/ollama-qwen3-14b   → Ollama Qwen3 14B (CUDA, tool calling)
 *   local/exo-llama-3b       → EXO Llama 3.2 3B (fast)
 *   claude-cli/sonnet         → Claude Sonnet 4.5 (subscription)
 *   claude-cli/opus           → Claude Opus 4.6 (subscription)
 *   codex/gpt-5.3             → GPT-5.3 Codex (subscription, code specialist)
 *   codex/o3                  → OpenAI o3 (subscription, reasoning specialist)
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
        "local/ollama-qwen3-14b",  // $0 local
        "claude-cli/sonnet",       // subscription
        "deepseek/deepseek-chat",  // $0.14/M (last resort)
      ],
    },

    // MEDIUM: code tasks, technical questions, multi-step instructions
    // → Ollama Qwen3 14B handles this well with native tool calling
    MEDIUM: {
      primary: "local/ollama-qwen3-14b",
      fallback: [
        "codex/gpt-5.3",          // subscription, code specialist
        "claude-cli/sonnet",       // subscription
        "deepseek/deepseek-chat",  // $0.14/M
      ],
    },

    // COMPLEX: architecture design, complex analysis, long-context tasks
    // → Claude Sonnet first, then Codex (subscription) before DeepSeek (paid)
    COMPLEX: {
      primary: "claude-cli/sonnet",
      fallback: [
        "codex/gpt-5.3",              // subscription — tried before DeepSeek
        "claude-cli/opus",             // subscription escalation
        "deepseek/deepseek-chat",      // $0.14/M
      ],
    },

    // REASONING: proofs, formal derivation, chain-of-thought, math
    // → Claude Opus first, then Codex o3 (subscription reasoning) before DeepSeek
    REASONING: {
      primary: "claude-cli/opus",
      fallback: [
        "codex/o3",                    // subscription — OpenAI reasoning model
        "deepseek/deepseek-reasoner",  // $0.55/M
        "claude-cli/sonnet",           // subscription downgrade
      ],
    },
  },

  // Agentic tiers: models with strong tool calling for multi-step tasks
  // Key: Ollama Qwen3 14B has native OpenAI tool calling (0.971 F1)
  // Codex GPT-5.3 also supports tool calling via <<<TOOL_CALL>>> protocol
  agenticTiers: {
    SIMPLE: {
      primary: "local/ollama-qwen3-14b",  // Native tool calling, $0
      fallback: [
        "codex/gpt-5.3",              // subscription, tool calling
        "claude-cli/sonnet",           // subscription
        "deepseek/deepseek-chat",      // $0.14/M
      ],
    },
    MEDIUM: {
      primary: "local/ollama-qwen3-14b",  // Strong tool calling for coding
      fallback: [
        "codex/gpt-5.3",              // subscription, code specialist
        "claude-cli/sonnet",           // subscription
        "deepseek/deepseek-chat",      // $0.14/M
      ],
    },
    COMPLEX: {
      primary: "claude-cli/sonnet",
      fallback: [
        "codex/gpt-5.3",              // subscription — before DeepSeek
        "claude-cli/opus",             // subscription escalation
        "deepseek/deepseek-chat",      // $0.14/M
      ],
    },
    REASONING: {
      primary: "claude-cli/opus",
      fallback: [
        "codex/o3",                    // subscription — reasoning specialist
        "deepseek/deepseek-reasoner",  // $0.55/M
        "claude-cli/sonnet",           // subscription downgrade
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

  // Codex CLI — subscription, no marginal cost per token
  ["codex/gpt-5.3", { inputPrice: 0, outputPrice: 0 }],
  ["codex/o3", { inputPrice: 0, outputPrice: 0 }],

  // DeepSeek — pay-per-token (prices in $ per 1M tokens)
  ["deepseek/deepseek-chat", { inputPrice: 0.14, outputPrice: 0.28 }],
  ["deepseek/deepseek-reasoner", { inputPrice: 0.55, outputPrice: 2.19 }],

  // Baseline for savings comparison (Opus API pricing)
  ["anthropic/claude-opus-4", { inputPrice: 15.0, outputPrice: 75.0 }],
]);
