/**
 * BlockRun Model Definitions for OpenClaw
 *
 * Maps BlockRun's 30+ AI models to OpenClaw's ModelDefinitionConfig format.
 * All models use the "openai-completions" API since BlockRun is OpenAI-compatible.
 *
 * Pricing is in USD per 1M tokens. Operators pay these rates via x402;
 * they set their own markup when reselling to end users (Phase 2).
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

/**
 * Model aliases for convenient shorthand access.
 * Users can type `/model claude` instead of `/model blockrun/anthropic/claude-sonnet-4`.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude
  claude: "anthropic/claude-sonnet-4",
  sonnet: "anthropic/claude-sonnet-4",
  opus: "anthropic/claude-opus-4",
  haiku: "anthropic/claude-haiku-4.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.2",
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
  "gpt-120b": "nvidia/gpt-oss-120b",

  // Note: auto, free, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs
};

/**
 * Resolve a model alias to its full model ID.
 * Also strips "blockrun/" prefix for direct model paths.
 * Examples:
 *   - "claude" -> "anthropic/claude-sonnet-4" (alias)
 *   - "blockrun/claude" -> "anthropic/claude-sonnet-4" (alias with prefix)
 *   - "blockrun/anthropic/claude-sonnet-4" -> "anthropic/claude-sonnet-4" (prefix stripped)
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
    // e.g., "blockrun/anthropic/claude-sonnet-4" -> "anthropic/claude-sonnet-4"
    return withoutPrefix;
  }

  return model;
}

type BlockRunModel = {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Models optimized for agentic workflows (multi-step autonomous tasks) */
  agentic?: boolean;
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
    name: "Free (NVIDIA GPT-OSS-120B only)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128_000,
    maxOutput: 4_096,
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
    inputPrice: 1.75,
    outputPrice: 14.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
    vision: true,
    agentic: true,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    inputPrice: 0.25,
    outputPrice: 2.0,
    contextWindow: 200000,
    maxOutput: 65536,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 32768,
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    inputPrice: 21.0,
    outputPrice: 168.0,
    contextWindow: 400000,
    maxOutput: 128000,
    reasoning: true,
  },

  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  // gpt-4.1-nano removed - replaced by gpt-5-nano
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
    agentic: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384,
  },

  // OpenAI O-series (Reasoning) - o1/o1-mini removed, replaced by o3/o4
  {
    id: "openai/o3",
    name: "o3",
    inputPrice: 2.0,
    outputPrice: 8.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
  },

  // Anthropic - all Claude models excel at agentic workflows
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    inputPrice: 1.0,
    outputPrice: 5.0,
    contextWindow: 200000,
    maxOutput: 8192,
    agentic: true,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
    agentic: true,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15.0,
    outputPrice: 75.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    agentic: true,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
    agentic: true,
  },

  // Google
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    inputPrice: 2.0,
    outputPrice: 12.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    inputPrice: 1.25,
    outputPrice: 10.0,
    contextWindow: 1050000,
    maxOutput: 65536,
    reasoning: true,
    vision: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 1000000,
    maxOutput: 65536,
  },

  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128000,
    maxOutput: 8192,
    reasoning: true,
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
    agentic: true,
  },

  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
  },

  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    agentic: true, // Good for coding tasks
  },
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  // grok-2-vision removed - old, 0 transactions

  // NVIDIA - Free/cheap models
  {
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    inputPrice: 0.55,
    outputPrice: 2.5,
    contextWindow: 262144,
    maxOutput: 16384,
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
