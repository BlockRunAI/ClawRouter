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
import { TOP_MODELS } from "./top-models.js";

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model blockrun/anthropic/claude-sonnet-4-6`.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude - flagship opus is 4.8; sonnet stays at 4.6
  claude: "anthropic/claude-sonnet-4.6",
  "br-sonnet": "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  "sonnet-4": "anthropic/claude-sonnet-4.6",
  "sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  // Explicit 4.5 pins (distinct model upstream, same pricing as 4.6)
  "sonnet-4.5": "anthropic/claude-sonnet-4.5",
  "sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  // claude-fable-5 DELISTED by Anthropic 2026-06-13 (offer withdrawn upstream —
  // no longer served on direct Anthropic or Bedrock). BlockRun removed the
  // catalog entry and redirects fable → opus-4.8 (route.ts MODEL_REDIRECTS).
  // Mirror that here so pinned callers silently land on opus-4.8.
  fable: "anthropic/claude-opus-4.8",
  "fable-5": "anthropic/claude-opus-4.8",
  "fable-5.0": "anthropic/claude-opus-4.8",
  opus: "anthropic/claude-opus-4.8",
  "opus-4": "anthropic/claude-opus-4.8",
  "opus-4.8": "anthropic/claude-opus-4.8",
  "opus-4-8": "anthropic/claude-opus-4.8",
  "opus-4.7": "anthropic/claude-opus-4.7",
  "opus-4-7": "anthropic/claude-opus-4.7",
  "opus-4.6": "anthropic/claude-opus-4.6",
  "opus-4-6": "anthropic/claude-opus-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  // fable-5 delisted 2026-06-13 → opus-4.8 (see note above)
  "anthropic/fable": "anthropic/claude-opus-4.8",
  "anthropic/claude-fable-5": "anthropic/claude-opus-4.8",
  "anthropic/claude-fable-5.0": "anthropic/claude-opus-4.8",
  "anthropic/opus": "anthropic/claude-opus-4.8",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // Backward compatibility - generic opus-4 and older flagships point at 4.8;
  // explicit version pins (claude-opus-4-7) stay on their version since server still routes them.
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4-8": "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4-7": "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-5": "anthropic/claude-opus-4.5",
  "anthropic/claude-haiku-4": "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.5",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4-pro": "openai/gpt-5.4-pro",
  "gpt-5.4-nano": "openai/gpt-5.4-nano",
  nano: "openai/gpt-5.4-nano",
  "gpt-5-nano": "openai/gpt-5.4-nano",
  codex: "openai/gpt-5.3-codex",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o1",
  // o1-mini delisted by OpenAI 2026-06-06 — mirror the gateway redirect.
  "openai/o1-mini": "openai/o4-mini",
  "o1-mini": "openai/o4-mini",
  o3: "openai/o3",
  // OpenAI Codex prefix aliases (OpenClaw v2026.4.5 openai-codex/ model ID format)
  "openai-codex/gpt-5.4-mini": "openai/gpt-5.4-mini",
  "gpt-5.4-mini": "openai/gpt-5.4-mini",

  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  "deepseek-chat": "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",

  // Kimi / Moonshot — K2.7 is the featured flagship on BlockRun (added 2026-06-13,
  // commit cd3d79b; K2.6 marked hidden/superseded, K2.5 hidden). Bare aliases now
  // resolve to K2.7 (same $0.95/$4.00 price as K2.6 — AT-COST, zero margin). Explicit
  // pins for "kimi-k2.6" / "kimi-k2.5" still resolve to those exact models (K2.5 is a
  // cost-stability opt-in at $0.60/$3.00). NVIDIA-hosted K2.5 was retired 2026-04-21.
  kimi: "moonshot/kimi-k2.7",
  moonshot: "moonshot/kimi-k2.7",
  "kimi-k2": "moonshot/kimi-k2.7",
  "kimi-k2.7": "moonshot/kimi-k2.7",
  "kimi-k2.6": "moonshot/kimi-k2.6",
  "kimi-k2.5": "moonshot/kimi-k2.5",
  "nvidia/kimi-k2.5": "moonshot/kimi-k2.5",

  // Google
  // gemini-3-pro-preview delisted by Google 2026-06-06 — mirror the gateway
  // redirect to its successor so pinned callers land on 3.1-pro, not an error.
  "google/gemini-3-pro-preview": "google/gemini-3.1-pro",
  "gemini-3-pro-preview": "google/gemini-3.1-pro",
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "google/gemini-3.1-pro-preview": "google/gemini-3.1-pro",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3.1-flash-lite": "google/gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",

  // xAI — grok-4.3 is the public flagship since 2026-06-04 (grok-3 and the
  // 4-fast/4-1-fast families are hidden in the backend catalog; direct full
  // IDs still resolve for pinned users).
  grok: "xai/grok-4.3",
  "grok-4.3": "xai/grok-4.3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-build": "xai/grok-build-0.1",
  "grok-code": "xai/grok-build-0.1", // xAI's agentic coding model (Build 0.1, 2026-06-04)
  // Delisted model redirects — full model IDs that were previously valid but removed
  "grok-code-fast-1": "deepseek/deepseek-chat", // bare alias (delisted SKU, kept on cheap chat)
  "xai/grok-code-fast-1": "deepseek/deepseek-chat", // delisted 2026-03-12
  "xai/grok-3-fast": "xai/grok-4-fast-reasoning", // delisted (too expensive)

  // NVIDIA — backward compat aliases (nvidia/xxx → free/xxx)
  // Default free model is gpt-oss-120b (heavy user demand). New free models
  // added 2026-04-29 — deepseek-v4-pro/flash, nemotron-omni — are additions,
  // not replacements. Retired-with-redirect entries below mirror BlockRun
  // server-side decommissioning of slow models (nemotron family, etc.).
  nvidia: "free/gpt-oss-120b",
  "gpt-120b": "free/gpt-oss-120b",
  "gpt-20b": "free/gpt-oss-20b",
  "nvidia/gpt-oss-120b": "free/gpt-oss-120b",
  "nvidia/gpt-oss-20b": "free/gpt-oss-20b",
  "nvidia/deepseek-v3.2": "free/deepseek-v4-flash", // v3.2 → v4-flash (v4-pro NVIDIA hung 2026-04-30)
  "free/deepseek-v3.2": "free/deepseek-v4-flash", // local pin redirect
  "nvidia/deepseek-v4-pro": "free/deepseek-v4-flash", // V4 Pro NVIDIA hung 2026-04-30
  "free/deepseek-v4-pro": "free/deepseek-v4-flash", // V4 Pro delisted — redirect pinned callers
  "nvidia/deepseek-v4-flash": "free/deepseek-v4-flash",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // qwen3-coder-480b retired (NVIDIA EOL 2026-06-14) → redirects to seed-oss-36b
  // server-side; keep the explicit id mappings for pinned callers (BlockRun still
  // resolves them), but point the generic coding shorthands at the live successor.
  "nvidia/qwen3-coder-480b": "free/qwen3-coder-480b",
  "qwen/qwen3-coder-480b-a35b-instruct": "free/qwen3-coder-480b",
  "nvidia/glm-4.7": "free/seed-oss-36b",
  "nvidia/llama-4-maverick": "free/llama-4-maverick",
  // qwen3-next thinking variant retired; live sibling is the instruct model
  "nvidia/qwen3-next-80b-a3b-thinking": "free/qwen3-next-80b-a3b-instruct",
  // New live free models from the 2026-06-14 BlockRun free-tier refresh
  "nvidia/qwen3-next-80b-a3b-instruct": "free/qwen3-next-80b-a3b-instruct",
  "nvidia/seed-oss-36b": "free/seed-oss-36b",
  "nvidia/mistral-nemotron": "free/mistral-nemotron",
  "nvidia/step-3.7-flash": "free/step-3.7-flash",
  "nvidia/nemotron-nano-9b-v2": "free/nemotron-nano-9b-v2",
  "nvidia/nemotron-nano-12b-v2-vl": "free/nemotron-nano-12b-v2-vl",
  "nvidia/mistral-small-4-119b": "free/llama-4-maverick", // NVIDIA upstream timing out — hidden + redirected server-side 2026-06-08
  // Retired free IDs → successors (mirror server-side redirects)
  "nvidia/nemotron-ultra-253b": "free/llama-4-maverick",
  "nvidia/nemotron-3-super-120b": "free/llama-4-maverick",
  "nvidia/nemotron-super-49b": "free/llama-4-maverick",
  // mistral-large-3-675b un-retired 2026-06-14: BlockRun re-featured it (available,
  // NVIDIA upstream recovered) so it's a real free catalog entry again.
  "nvidia/mistral-large-3-675b": "free/mistral-large-3-675b",
  "nvidia/qwen3.5-122b-a10b": "free/qwen3.5-122b-a10b",
  "nvidia/devstral-2-123b": "free/seed-oss-36b",
  "free/nemotron-ultra-253b": "free/llama-4-maverick",
  "free/nemotron-3-super-120b": "free/llama-4-maverick",
  "free/nemotron-super-49b": "free/llama-4-maverick",
  "free/devstral-2-123b": "free/seed-oss-36b",
  // New blockrun-featured free models (2026-06-14 catalog sweep)
  "mistral-large": "free/mistral-large-3-675b",
  "mistral-large-3-675b": "free/mistral-large-3-675b",
  "qwen3.5-122b": "free/qwen3.5-122b-a10b",
  "qwen3-122b": "free/qwen3.5-122b-a10b",
  // Free model shorthand aliases
  "deepseek-free": "free/deepseek-v4-flash", // V4 Pro NVIDIA hung 2026-04-30 → flash
  "deepseek-v4-pro": "free/deepseek-v4-flash", // free shorthand → flash (pro hung)
  "deepseek-v4-flash": "free/deepseek-v4-flash",
  "v4-pro": "free/deepseek-v4-flash", // V4 Pro NVIDIA hung → flash
  "v4-flash": "free/deepseek-v4-flash",
  "mistral-free": "free/llama-4-maverick",
  "glm-free": "free/seed-oss-36b", // qwen3-coder retired → live coder successor
  "llama-free": "free/llama-4-maverick",
  "qwen-coder": "free/seed-oss-36b", // qwen3-coder-480b retired → seed-oss-36b
  "qwen-coder-free": "free/seed-oss-36b",
  "qwen-thinking": "free/qwen3-next-80b-a3b-instruct",
  "qwen3-next": "free/qwen3-next-80b-a3b-instruct", // now a live model (instruct)
  "qwen3-next-80b": "free/qwen3-next-80b-a3b-instruct",
  "mistral-small": "free/llama-4-maverick",
  // New live free models (2026-06-14 BlockRun free-tier refresh)
  "seed-oss": "free/seed-oss-36b",
  "seed-oss-36b": "free/seed-oss-36b",
  "coder-free": "free/seed-oss-36b",
  "mistral-nemotron": "free/mistral-nemotron",
  "step-flash": "free/step-3.7-flash",
  "step-3.7-flash": "free/step-3.7-flash",
  "nemotron-nano-9b": "free/nemotron-nano-9b-v2",
  "nemotron-nano": "free/nemotron-nano-9b-v2",
  "nemotron-nano-vl": "free/nemotron-nano-12b-v2-vl",
  "nano-vl": "free/nemotron-nano-12b-v2-vl",
  // Vision-capable free models
  "nemotron-omni": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nano-omni": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  "vision-free": "free/nemotron-3-nano-omni-30b-a3b-reasoning",
  // Retired shorthand aliases redirect to successors
  nemotron: "free/llama-4-maverick",
  "nemotron-ultra": "free/llama-4-maverick",
  "nemotron-253b": "free/llama-4-maverick",
  "nemotron-super": "free/llama-4-maverick",
  "nemotron-49b": "free/llama-4-maverick",
  "nemotron-120b": "free/llama-4-maverick",
  devstral: "free/seed-oss-36b",
  "devstral-2": "free/seed-oss-36b",
  maverick: "free/llama-4-maverick",
  free: "free/gpt-oss-120b",

  // MiniMax (minimax → current flagship: M3)
  minimax: "minimax/minimax-m3",
  "minimax-m3": "minimax/minimax-m3",
  "minimax-m2.7": "minimax/minimax-m2.7",
  "minimax-m2.5": "minimax/minimax-m2.5",

  // Z.AI GLM-5
  glm: "zai/glm-5.2", // bare alias tracks newest flagship (launched 2026-06-16)
  "glm-5.2": "zai/glm-5.2",
  "glm-5": "zai/glm-5",
  "glm-5.1": "zai/glm-5.1", // explicit pin: 200K-ctx predecessor, same price
  "glm-5-turbo": "zai/glm-5-turbo",

  // Routing profile aliases (common variations)
  "auto-router": "auto",
  router: "auto",

  // Note: auto, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs

  // Image generation
  dalle: "openai/dall-e-3",
  "dall-e": "openai/dall-e-3",
  "gpt-image": "openai/gpt-image-1",
  "nano-banana": "google/nano-banana",
  banana: "google/nano-banana",
  "banana-pro": "google/nano-banana-pro",
  "nano-banana-pro": "google/nano-banana-pro",
  flux: "black-forest/flux-1.1-pro",
  "flux-pro": "black-forest/flux-1.1-pro",
  "grok-imagine": "xai/grok-imagine-image",
  "grok-imagine-pro": "xai/grok-imagine-image-pro",
  cogview: "zai/cogview-4",

  // Video generation
  "grok-video": "xai/grok-imagine-video",
  seedance: "bytedance/seedance-1.5-pro",
  "seedance-1.5": "bytedance/seedance-1.5-pro",
  "seedance-2-fast": "bytedance/seedance-2.0-fast",
  "seedance-2": "bytedance/seedance-2.0",
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

  // Strip "openai-codex/" prefix (OpenClaw v2026.4.5 model ID format).
  // e.g. "openai-codex/gpt-5.4-mini" -> check alias, then strip prefix.
  if (normalized.startsWith("openai-codex/")) {
    const withoutPrefix = normalized.slice("openai-codex/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;

    // Fall back to checking if the bare name is a known model
    const isKnownModel = BLOCKRUN_MODELS.some((m) => m.id === withoutPrefix);
    if (isKnownModel) return withoutPrefix;
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
  /** Time-limited promotional pricing — auto-expires after endDate */
  promo?: {
    /** Flat price per request in USD (replaces token-based pricing) */
    flatPrice: number;
    /** ISO date, promo starts (inclusive). e.g. "2026-04-01" */
    startDate: string;
    /** ISO date, promo ends (exclusive). e.g. "2026-04-15" */
    endDate: string;
  };
  /**
   * Permanent flat per-request price in USD (backend billingMode: "flat").
   * Unlike promo, this never expires. Takes precedence over promo.
   */
  flatPrice?: number;
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
    name: "Free → GPT-OSS 120B",
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
  // GPT-5.5 — newest visible flagship in blockrun. First fully retrained base since
  // GPT-4.5; 1M+ context, native agent + computer use. Costs 2x gpt-5.4 — routing
  // tiers still default to gpt-5.4 because it's benchmarked; users can pin 5.5.
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    version: "5.5",
    inputPrice: 5.0,
    outputPrice: 30.0,
    contextWindow: 1050000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // GPT-5.4 — flagship benchmarked into routing tiers
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
    id: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    version: "5.4",
    inputPrice: 0.75,
    outputPrice: 4.5,
    contextWindow: 400000,
    maxOutput: 128000,
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
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    version: "4.5",
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
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    version: "4.5",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 200000,
    maxOutput: 32000,
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
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  // claude-fable-5 DELISTED by Anthropic 2026-06-13 (offer withdrawn upstream;
  // BlockRun removed its catalog entry and redirects → opus-4.8). Catalog entry
  // removed here; fable aliases now resolve to opus-4.8. Re-add if access returns.
  {
    id: "anthropic/claude-opus-4.7",
    name: "Claude Opus 4.7",
    version: "4.7",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    version: "4.8",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 1000000,
    maxOutput: 128000,
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
    // Latest-generation Flash with built-in thinking mode (backend
    // 2026-05-19) — frontier-class quality at Flash pricing.
    id: "google/gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    version: "3.5",
    inputPrice: 0.5,
    outputPrice: 3.0,
    contextWindow: 1048576,
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

  // DeepSeek — V4 family (2026-04-24). The legacy deepseek-chat/reasoner
  // aliases are served upstream as V4 Flash non-thinking / thinking modes.
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V4 Flash Chat",
    version: "4-flash",
    inputPrice: 0.2,
    outputPrice: 0.4,
    contextWindow: 1000000,
    maxOutput: 8192,
    toolCalling: true,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V4 Flash Reasoner",
    version: "4-flash",
    inputPrice: 0.2,
    outputPrice: 0.4,
    contextWindow: 1000000,
    maxOutput: 8192,
    reasoning: true,
    toolCalling: true,
  },
  {
    // V4 flagship — strongest open-weight reasoner. The 75% launch promo
    // became DeepSeek's permanent list price after 2026-05-31. Resold via
    // BlockRun's OpenRouter credit pool. Was listed in top-models.json
    // without a catalog entry, which silently dropped it from the picker.
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    version: "4-pro",
    inputPrice: 0.435,
    outputPrice: 0.87,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K2.7 — Moonshot's flagship (added 2026-06-13). 256K context, multi-modal
  // (image + VIDEO input), returns reasoning_content. Served via BlockRun's OpenRouter
  // credit pool (slug moonshotai/kimi-k2.7-code) failing over to direct Moonshot.
  // AT-COST pricing ($0.95/$4.00 = OpenRouter COGS, zero margin) — same as K2.6.
  {
    id: "moonshot/kimi-k2.7",
    name: "Kimi K2.7",
    version: "k2.7",
    inputPrice: 0.95,
    outputPrice: 4.0,
    contextWindow: 262144,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K2.6 — superseded by K2.7 (2026-06-13), hidden on BlockRun but still routable.
  {
    id: "moonshot/kimi-k2.6",
    name: "Kimi K2.6",
    version: "k2.6",
    inputPrice: 0.95,
    outputPrice: 4.0,
    contextWindow: 262144,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },

  // Kimi K2.5 — Moonshot direct is primary (better SLA). NVIDIA-hosted variant
  // retired 2026-04-21 (slow throughput) and now redirects to moonshot.
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "Kimi K2.5 (NVIDIA, retired)",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
    deprecated: true,
    fallbackModel: "moonshot/kimi-k2.5",
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

  // xAI Grok 4.20 Family (hidden in picker; explicit-only — mirrors BlockRun hidden:true)
  {
    id: "xai/grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-4.20-non-reasoning",
    name: "Grok 4.20",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    toolCalling: true,
  },
  {
    id: "xai/grok-4.20-multi-agent",
    name: "Grok 4.20 Multi-Agent",
    version: "4.20",
    inputPrice: 2.0,
    outputPrice: 6.0,
    contextWindow: 2000000,
    maxOutput: 16384,
    reasoning: true,
    toolCalling: true,
  },

  // xAI via BlockRun's OpenRouter credit pool (public in backend catalog,
  // added 2026-06-04). Picker-visible — listed in top-models.json.
  {
    id: "xai/grok-4.3",
    name: "Grok 4.3",
    version: "4.3",
    inputPrice: 1.5,
    outputPrice: 4.0,
    contextWindow: 1000000,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "xai/grok-build-0.1",
    name: "Grok Build 0.1",
    version: "0.1",
    inputPrice: 1.5,
    outputPrice: 3.0,
    contextWindow: 256000,
    maxOutput: 16384,
    agentic: true,
    toolCalling: true,
  },

  // MiniMax
  {
    id: "minimax/minimax-m3",
    name: "MiniMax M3",
    version: "m3",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 1048576,
    maxOutput: 65536,
    reasoning: true,
    agentic: true,
    toolCalling: true,
  },
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
    deprecated: true,
    fallbackModel: "minimax/minimax-m2.7",
  },

  // Free models (hosted by NVIDIA, billingMode: "free" on server)
  // IDs use "free/" prefix so users see them as free in the /model picker.
  // ClawRouter maps free/xxx → nvidia/xxx before sending to BlockRun upstream
  // (see toUpstreamModelId in src/proxy.ts). BlockRun's NVIDIA_MODEL_MAP in
  // src/lib/ai-providers.ts maps known IDs to upstream NIM names; for IDs not
  // in the map, BlockRun falls through to the bare name (modelMap[k] || k),
  // so new entries here only need to match BlockRun's catalog ID — NVIDIA NIM
  // accepts the bare name directly.
  // toolCalling intentionally omitted: structured function calling unverified.
  // 2026-04-29: kept gpt-oss-120b/20b as defaults (heavy user demand); added
  //   v4-pro / v4-flash (1M context, ~5x speed split) and nemotron-3-nano-omni
  //   (first vision-capable free model, 256K context, accepts text/image/video/audio).
  // 2026-04-21: slimmed to 8 models, retired nemotron family + mistral-large-3-675b
  //   + devstral-2-123b with successor redirects.
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
    // V4 Flash: 284B / 13B active MoE, 1M context. ~5x faster than V4 Pro.
    // Strong on chat/summarization (MMLU-Pro 86.2). Caveat: weaker factual
    // recall (SimpleQA 34% vs Pro's 58%) — pick V4 Pro for fact-heavy loops.
    id: "free/deepseek-v4-flash",
    name: "[Free] DeepSeek V4 Flash",
    version: "v4-flash",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1000000,
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
  {
    // Nemotron 3 Nano Omni: first vision-capable free model. 31B / 3.2B active
    // MoE, 256K context. ChartQA 90.3, DocVQA 95.6, MMMU 70.8. Accepts text,
    // images, video (up to 2min), audio (up to 1hr). Released 2026-04-27.
    id: "free/nemotron-3-nano-omni-30b-a3b-reasoning",
    name: "[Free] Nemotron 3 Nano Omni",
    version: "30b-a3b-omni-reasoning",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 256000,
    maxOutput: 16384,
    reasoning: true,
    vision: true,
  },
  // 2026-06-14: BlockRun re-featured these two as free flagships (catalog sweep).
  // Added to the auto-pick set behind gpt-oss to strengthen the mid/back of the
  // free cascade with strong general models.
  {
    // Mistral Large 3: 675B dense flagship, strong general reasoning. Un-retired
    // 2026-06-14 (NVIDIA upstream recovered; BlockRun marks it available + featured).
    id: "free/mistral-large-3-675b",
    name: "[Free] Mistral Large 3 675B",
    version: "3-675b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // Qwen3.5 122B (A10B active MoE): newest-gen Qwen, strong general capability.
    id: "free/qwen3.5-122b-a10b",
    name: "[Free] Qwen3.5 122B",
    version: "3.5-122b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  // 2026-06-16: BlockRun's 2026-06-14 free-tier refresh (self-healing health gate
  // + probe-verified lineup, blockrun commit 5817ecd) added these live NVIDIA free
  // models. qwen3-coder-480b was retired (NVIDIA EOL 2026-06-14) and now redirects
  // server-side to seed-oss-36b; deepseek-v4-flash/glm-4.7 stay catalog-only.
  {
    // Qwen3-Next 80B (A3B active MoE): 262K context, strong reasoning + coding.
    id: "free/qwen3-next-80b-a3b-instruct",
    name: "[Free] Qwen3-Next 80B Instruct",
    version: "next-80b-a3b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 262144,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // ByteDance Seed-OSS 36B: strong open-source coder, 131K context. Successor
    // to the retired qwen3-coder-480b (BlockRun redirects qwen3-coder → seed-oss).
    id: "free/seed-oss-36b",
    name: "[Free] Seed-OSS 36B",
    version: "oss-36b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    // Mistral × NVIDIA hybrid: strong instruction following, 131K context.
    id: "free/mistral-nemotron",
    name: "[Free] Mistral Nemotron",
    version: "nemotron",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    // StepFun Step 3.7 Flash: reasoning-focused, 131K context.
    id: "free/step-3.7-flash",
    name: "[Free] StepFun Step 3.7 Flash",
    version: "3.7-flash",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    // NVIDIA Nemotron Nano 9B v2: fast lightweight generalist, 131K context.
    id: "free/nemotron-nano-9b-v2",
    name: "[Free] Nemotron Nano 9B v2",
    version: "nano-9b-v2",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    // NVIDIA Nemotron Nano 12B v2 VL: vision-language (text + image), 131K context.
    id: "free/nemotron-nano-12b-v2-vl",
    name: "[Free] Nemotron Nano 12B v2 VL",
    version: "nano-12b-v2-vl",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 131072,
    maxOutput: 16384,
    vision: true,
  },

  // Z.AI GLM-5 Models
  {
    // Launched 2026-06-16 — Z.AI's newest flagship. 1M-token context,
    // beats GPT-5.5 on long-horizon coding at a fraction of the cost.
    // Paid per-token at $1.40/$4.40 (same as glm-5.1, cached $0.26).
    id: "zai/glm-5.2",
    name: "GLM-5.2",
    version: "5.2",
    inputPrice: 1.4,
    outputPrice: 4.4,
    contextWindow: 1000000,
    maxOutput: 262144,
    toolCalling: true,
  },
  {
    // Launch promo (flat $0.001/call) ended 2026-06-05 — backend now bills
    // glm-5.1 per-token at $1.40/$4.40 (billingMode: "paid").
    id: "zai/glm-5.1",
    name: "GLM-5.1",
    version: "5.1",
    inputPrice: 1.4,
    outputPrice: 4.4,
    contextWindow: 200000,
    maxOutput: 128000,
    toolCalling: true,
    promo: { flatPrice: 0.001, startDate: "2026-04-01", endDate: "2026-06-05" },
  },
  {
    // Flat-rate launch promo ended 2026-06-06 — backend bills per-token now.
    id: "zai/glm-5",
    name: "GLM-5",
    version: "5",
    inputPrice: 0.6,
    outputPrice: 1.92,
    contextWindow: 200000,
    maxOutput: 128000,
    toolCalling: true,
  },
  {
    // Flat-rate launch promo ended 2026-06-06 — backend bills per-token now.
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
 * Get the active flat price for a model, or undefined if none.
 * Permanent flat pricing (flatPrice) never expires; promos auto-expire
 * after their endDate.
 */
export function getActivePromoPrice(
  model: BlockRunModel,
  now: Date = new Date(),
): number | undefined {
  if (model.flatPrice !== undefined) return model.flatPrice;
  if (!model.promo) return undefined;
  const start = new Date(model.promo.startDate);
  const end = new Date(model.promo.endDate);
  if (now >= start && now < end) return model.promo.flatPrice;
  return undefined;
}

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
 *
 * Only friendly short names are advertised. Full `provider/model` keys in
 * MODEL_ALIASES are backward-compat / delisted redirects whose target is a real
 * model that is already listed — surfacing them as their own entries is wrong
 * (e.g. `free/deepseek-v4-pro` was delisted 2026-04-30 and redirects to
 * `free/deepseek-v4-flash`, yet showed up as a listable "V4 Pro" model). They
 * stay fully callable via resolveModelAlias(); they just must not appear in
 * `/v1/models` or any picker.
 */
const ALIAS_MODELS: ModelDefinitionConfig[] = Object.entries(MODEL_ALIASES)
  .filter(([alias]) => !alias.includes("/"))
  .map(([alias, targetId]) => {
    const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
    if (!target) return null;
    return toOpenClawModel({ ...target, id: alias, name: `${alias} → ${target.name}` });
  })
  .filter((m): m is ModelDefinitionConfig => m !== null);

/**
 * All BlockRun models in OpenClaw format (including aliases).
 * Used for proxy-side resolution (alias → target ID), tool routing, etc.
 *
 * Catalog entries shadowed by an identically-keyed alias are excluded:
 * resolveModelAlias checks MODEL_ALIASES first, so those catalog entries are
 * unreachable and their metadata (name/pricing) would misadvertise what
 * callers actually get. The alias-derived entry carries the redirect
 * target's real metadata instead.
 */
export const OPENCLAW_MODELS: ModelDefinitionConfig[] = [
  ...BLOCKRUN_MODELS.filter((m) => !(m.id in MODEL_ALIASES)).map(toOpenClawModel),
  ...ALIAS_MODELS,
];

/**
 * Subset of OPENCLAW_MODELS the OpenClaw `/model` picker advertises —
 * driven by `src/top-models.json`. Hidden entries remain callable via direct
 * ID and via aliases; they just don't clutter the picker.
 */
const OPENCLAW_MODEL_BY_ID = new Map(OPENCLAW_MODELS.map((m) => [m.id, m]));
export const VISIBLE_OPENCLAW_MODELS: ModelDefinitionConfig[] = TOP_MODELS.flatMap((id) => {
  const model = OPENCLAW_MODEL_BY_ID.get(id);
  return model ? [model] : [];
});

/**
 * Build a ModelProviderConfig for BlockRun.
 *
 * Returns only the TOP_MODELS-listed subset so the OpenClaw picker stays
 * focused. Hidden models are still resolvable through the proxy.
 *
 * @param baseUrl - The proxy's local base URL (e.g., "http://127.0.0.1:12345")
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: VISIBLE_OPENCLAW_MODELS,
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
