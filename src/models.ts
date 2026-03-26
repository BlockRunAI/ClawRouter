/**
 * BlockRun Model Definitions for OpenClaw
 *
 * Maps BlockRun's 55+ AI models to OpenClaw's ModelDefinitionConfig format.
 * All models use the "openai-completions" API since BlockRun is OpenAI-compatible.
 *
 * Pricing is in USD per 1M tokens. Operators pay these rates via x402;
 * they set their own markup when reselling to end users (Phase 2).
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model blockrun/anthropic/claude-sonnet-4-6`.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude - use newest versions (4.6)
  claude: "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  "sonnet-4": "anthropic/claude-sonnet-4.6",
  "sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.6",
  "opus-4": "anthropic/claude-opus-4.6",
  "opus-4.6": "anthropic/claude-opus-4.6",
  "opus-4-6": "anthropic/claude-opus-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  "anthropic/opus": "anthropic/claude-opus-4.6",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // Backward compatibility - map all variants to 4.6
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5": "anthropic/claude-opus-4.6",
  "anthropic/claude-haiku-4": "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.4",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4-pro": "openai/gpt-5.4-pro",
  "gpt-5.4-nano": "openai/gpt-5.4-nano",
  nano: "openai/gpt-5.4-nano",
  "gpt-5-nano": "openai/gpt-5.4-nano",
  codex: "openai/gpt-5.3-codex",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o1",
  o3: "openai/o3",

  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  "deepseek-chat": "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",

  // Kimi / Moonshot
  kimi: "moonshot/kimi-k2.5",
  moonshot: "moonshot/kimi-k2.5",
  "kimi-k2.5": "moonshot/kimi-k2.5",

  // Google
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "google/gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",

  // xAI
  grok: "xai/grok-3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-code": "deepseek/deepseek-chat", // was grok-code-fast-1, delisted due to poor retention
  // Delisted model redirects — full model IDs that were previously valid but removed
  "grok-code-fast-1": "deepseek/deepseek-chat", // bare alias
  "xai/grok-code-fast-1": "deepseek/deepseek-chat", // delisted 2026-03-12
  "xai/grok-3-fast": "xai/grok-4-fast-reasoning", // delisted (too expensive)

  // NVIDIA — backward compat aliases (nvidia/xxx → free/xxx)
  nvidia: "free/gpt-oss-120b",
  "gpt-120b": "free/gpt-oss-120b",
  "gpt-20b": "free/gpt-oss-20b",
  "nvidia/gpt-oss-120b": "free/gpt-oss-120b",
  "nvidia/gpt-oss-20b": "free/gpt-oss-20b",
  "nvidia/nemotron-ultra-253b": "free/nemotron-ultra-253b",
  "nvidia/nemotron-3-super-120b": "free/nemotron-3-super-120b",
  "nvidia/nemotron-super-49b": "free/nemotron-super-49b",
  "nvidia/deepseek-v3.2": "free/deepseek-v3.2",
  "nvidia/mistral-large-3-675b": "free/mistral-large-3-675b",
  "nvidia/qwen3-coder-480b": "free/qwen3-coder-480b",
  "nvidia/devstral-2-123b": "free/devstral-2-123b",
  "nvidia/glm-4.7": "free/glm-4.7",
  "nvidia/llama-4-maverick": "free/llama-4-maverick",
  // Free model shorthand aliases
  "deepseek-free": "free/deepseek-v3.2",
  "mistral-free": "free/mistral-large-3-675b",
  "glm-free": "free/glm-4.7",
  "llama-free": "free/llama-4-maverick",
  nemotron: "free/nemotron-ultra-253b",
  "nemotron-ultra": "free/nemotron-ultra-253b",
  "nemotron-253b": "free/nemotron-ultra-253b",
  "nemotron-super": "free/nemotron-super-49b",
  "nemotron-49b": "free/nemotron-super-49b",
  "nemotron-120b": "free/nemotron-3-super-120b",
  devstral: "free/devstral-2-123b",
  "devstral-2": "free/devstral-2-123b",
  "qwen-coder": "free/qwen3-coder-480b",
  "qwen-coder-free": "free/qwen3-coder-480b",
  maverick: "free/llama-4-maverick",
  free: "free/nemotron-ultra-253b",

  // MiniMax
  minimax: "minimax/minimax-m2.7",
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m2.5": "minimax/minimax-m2.5",

  // Z.AI GLM-5
  glm: "zai/glm-5",
  "glm-5": "zai/glm-5",
  "glm-5-turbo": "zai/glm-5-turbo",

  // Routing profile aliases (common variations)
  "auto-router": "auto",
  router: "auto",

  // Note: auto, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs
};

/**
 * Resolve a model alias to its full model ID.
 * Also strips "blockrun/" prefix for direct model paths.
 * Examples:
 *   - "claude" -> "anthropic/claude-sonnet-4-6" (alias)
 *   - "blockrun/claude" -> "anthropic/claude-sonnet-4-6" (alias with prefix)
 *   - "blockrun/anthropic/claude-sonnet-4-6" -> "anthropic/claude-sonnet-4-6" (prefix stripped)
 *   - "openai/gpt-4o" -> "openai/gpt-4o" (unchanged)
 */
export function resolveModelAlias(model: string): string {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved) return resolved;

  // Check with "blockrun/" prefix stripped
  if (normalized.startsWith("blockrun/")) {
    const withoutPrefix = normalized.slice("blockrun/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // Even if not an alias, strip the prefix for direct model paths
    // e.g., "blockrun/anthropic/claude-sonnet-4-6" -> "anthropic/claude-sonnet-4-6"
    return withoutPrefix;
  }

  // Strip "openai/" prefix when it wraps a virtual routing profile or alias.
  // OpenClaw sends virtual models as "openai/eco", "openai/auto", etc. because
  // the provider uses the openai-completions API type.
  if (normalized.startsWith("openai/")) {
    const withoutPrefix = normalized.slice("openai/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // If it's a known BlockRun virtual profile (eco, auto, premium), return bare id
    const isVirtualProfile = BLOCKRUN_MODELS.some((m) => m.id === withoutPrefix);
    if (isVirtualProfile) return withoutPrefix;
  }

  return model;
}

type BlockRunModel = {
  id: string;
  name: string;
  /** Model version (e.g., "4.6", "3.1", "5.2") for tracking updates */
  version?: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Models optimized for agentic workflows (multi-step autonomous tasks) */
  agentic?: boolean;
  /**
   * Model supports OpenAI-compatible structured function/tool calling.
   * Models without this flag output tool invocations as plain text JSON,
   * which leaks raw {"command":"..."} into visible chat messages.
   * Default: false (must opt-in to prevent silent regressions on new models).
   */
  toolCalling?: boolean;
  /** Model is deprecated — will be routed to fallbackModel if set */
  deprecated?: boolean;
  /** Model ID to route to when this model is deprecated */
  fallbackModel?: string;
};

export const BLOCKRUN_MODELS: BlockRunModel[] = [
  // Smart routing meta-models — proxy replaces with actual model
  // NOTE: Model IDs are WITHOUT provider prefix (OpenClaw adds "blockrun/" automatically)
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "free",
    name: "Free → Nemotron Ultra 253B",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131_072,
    maxOutput: 16_384,
    reasoning: true,
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 2_000_000,
    maxOutput: 200_000,
  },

  // OpenAI GPT-5 Family
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    version: "5.0",
    inputPrice: 0.25,
    outputPrice: 2.0,
    contextWindow: 200000,
    maxOutput: 65536,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    version: "5.0",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 32768,
    toolCalling: true,
    deprecated: true,
    fallbackModel: "openai/gpt-5.4-nano",
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    version: "5.2",
    inputPrice: 21.0,
    outputPrice: 168.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },
  // GPT-5.4 — newest flagship, same input price as 4o but much more capable
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    version: "5.4",
    inputPrice: 2.5,
    outputPrice: 15.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    version: "5.4",
    inputPrice: 30.0,
    outputPrice: 180.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    version: "5.4",
    inputPrice: 0.2,
    outputPrice: 1.25,
    contextWindow: 1050000,
    maxOutput: 32768,
    toolCalling: true,
  },

  // OpenAI GPT-5.3 Family
  {
    id: "openai/gpt-5.3",
    name: "GPT-5.3",
    version: "5.3",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 128000,
    maxOutput: 16000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // OpenAI Codex Family
  {
    id: "openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    version: "5.3",
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    agentic: true,
    toolCalling: true,
  },

  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    version: "4.1",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    version: "4.1",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    version: "4.1",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    version: "4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    version: "4o-mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384,
    toolCalling: true,
  },

  // OpenAI O-series (Reasoning)
  {
    id: "openai/o1",
    name: "o1",
    version: "1",
    inputPrice: 15.0,
    outputPrice: 60.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    version: "1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3",
    name: "o3",
    version: "3",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    version: "3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    version: "4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
    toolCalling: true,
  },

  // Anthropic - all Claude models excel at agentic workflows
  // Use newest versions (4.6) with full provider prefix
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    version: "4.5",
    inputPrice: 1.0,
    outputPrice: 5.0,
    contextWindow: 200000,
    maxOutput: 8192,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    version: "4.6",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    version: "4.6",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Google
  {
    id: "google/gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    version: "3.1",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    version: "3.0",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    version: "3.0",
    inputPrice: 0.5,
    outputPrice: 3.0,
    contextWindow: 1000000,
    maxOutput: 65536,
    vision: true,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    version: "2.5",
    inputPrice: 1.25,
    outputPrice: 10.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    version: "2.5",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1000000,
    maxOutput: 65536,
    vision: true,
    toolCalling: true,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    version: "2.5",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 1000000,
    maxOutput: 65536,
    toolCalling: true,
  },
  {
    id: "google/gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    version: "3.1",
    inputPrice: 0.25,
    outputPrice: 1.5,
    contextWindow: 1000000,
    maxOutput: 8192,
    toolCalling: true,
  },

  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    toolCalling: true,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    reasoning: true,
    toolCalling: true,
  },

  // Moonshot / Kimi - optimized for agentic workflows
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    version: "3",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    version: "3-mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },

  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    toolCalling: true,
  },
  // xai/grok-code-fast-1 delisted 2026-03-12: poor retention (coding users churn),
  // no structured tool calling, alias "grok-code" redirected to deepseek-chat
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    version: "4-0709",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-2-vision",
    name: "Grok 2 Vision",
    version: "2",
    inputPrice: 2.0,
    outputPrice: 10.0,
    contextWindow: 131072,
    maxOutput: 16384,
    vision: true,
    toolCalling: true,
  },

  // MiniMax
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    version: "m2.7",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    version: "m2.5",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },

  // Free models (hosted by NVIDIA, billingMode: "free" on server)
  // IDs use "free/" prefix so users see them as free in the /model picker.
  // ClawRouter maps free/xxx → nvidia/xxx before sending to BlockRun upstream.
  // toolCalling intentionally omitted: structured function calling unverified.
  {
    id: "free/gpt-oss-120b",
    name: "[Free] GPT-OSS 120B",
    version: "120b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: "free/gpt-oss-20b",
    name: "[Free] GPT-OSS 20B",
    version: "20b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: "free/nemotron-ultra-253b",
    name: "[Free] Nemotron Ultra 253B",
    version: "253b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/nemotron-3-super-120b",
    name: "[Free] Nemotron 3 Super 120B",
    version: "3-super-120b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/nemotron-super-49b",
    name: "[Free] Nemotron Super 49B",
    version: "super-49b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/deepseek-v3.2",
    name: "[Free] DeepSeek V3.2",
    version: "v3.2",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/mistral-large-3-675b",
    name: "[Free] Mistral Large 675B",
    version: "3-675b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/qwen3-coder-480b",
    name: "[Free] Qwen3 Coder 480B",
    version: "480b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    id: "free/devstral-2-123b",
    name: "[Free] Devstral 2 123B",
    version: "2-123b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    id: "free/glm-4.7",
    name: "[Free] GLM-4.7",
    version: "4.7",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "free/llama-4-maverick",
    name: "[Free] Llama 4 Maverick",
    version: "4-maverick",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },

  // NVIDIA - Paid models
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 16384,
    toolCalling: true,
  },

  // Z.AI GLM-5 Models
  {
    id: "zai/glm-5",
    name: "GLM-5",
    version: "5",
    inputPrice: 1.0,
    outputPrice: 3.2,
    contextWindow: 200000,
    maxOutput: 128000,
    toolCalling: true,
  },
  {
    id: "zai/glm-5-turbo",
    name: "GLM-5 Turbo",
    version: "5-turbo",
    inputPrice: 1.2,
    outputPrice: 4.0,
    contextWindow: 200000,
    maxOutput: 128000,
    toolCalling: true,
  },
];

/**
 * Convert BlockRun model definitions to OpenClaw ModelDefinitionConfig format.
 */
function toOpenClawModel(m: BlockRunModel): ModelDefinitionConfig {
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
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput,
  };
}

/**
 * Alias models that map to real models.
 * These allow users to use friendly names like "free" or "gpt-120b".
 */
const ALIAS_MODELS: ModelDefinitionConfig[] = Object.entries(MODEL_ALIASES)
  .map(([alias, targetId]) => {
    const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
    if (!target) return null;
    return toOpenClawModel({ ...target, id: alias, name: `${alias} → ${target.name}` });
  })
  .filter((m): m is ModelDefinitionConfig => m !== null);

/**
 * All BlockRun models in OpenClaw format (including aliases).
 */
export const OPENCLAW_MODELS: ModelDefinitionConfig[] = [
  ...BLOCKRUN_MODELS.map(toOpenClawModel),
  ...ALIAS_MODELS,
];

/**
 * Build a ModelProviderConfig for BlockRun.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:12345")
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: OPENCLAW_MODELS,
  };
}

/**
 * Check if a model is optimized for agentic workflows.
 * Agentic models continue autonomously with multi-step tasks
 * instead of stopping and waiting for user input.
 */
export function isAgenticModel(modelId: string): boolean {
  const model = BLOCKRUN_MODELS.find(
    (m) => m.id === modelId || m.id === modelId.replace("blockrun/", ""),
  );
  return model?.agentic ?? false;
}

/**
 * Get all agentic-capable models.
 */
export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => m.agentic).map((m) => m.id);
}

/**
 * Check if a model supports OpenAI-compatible structured tool/function calling.
 * Models without this flag (e.g. grok-code-fast-1) output tool invocations as
 * plain text JSON, which leaks {"command":"..."} into visible chat messages.
 */
export function supportsToolCalling(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.toolCalling ?? false;
}

/**
 * Check if a model supports vision (image inputs).
 * Models without this flag cannot process image_url content parts.
 */
export function supportsVision(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.vision ?? false;
}

/**
 * Get context window size for a model.
 * Returns undefined if model not found.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.contextWindow;
}

/**
 * Check if a model has reasoning/thinking capabilities.
 * Reasoning models may require reasoning_content in assistant tool_call messages.
 */
export function isReasoningModel(modelId: string): boolean {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.reasoning ?? false;
}
