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

type BlockRunModel = {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
};

export const BLOCKRUN_MODELS: BlockRunModel[] = [
  // Smart routing meta-model — proxy replaces with actual model
  {
    id: "blockrun/auto",
    name: "BlockRun Smart Router",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
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
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    contextWindow: 128000,
    maxOutput: 16384,
    vision: true,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128000,
    maxOutput: 16384,
  },

  // OpenAI O-series (Reasoning)
  {
    id: "openai/o1",
    name: "o1",
    inputPrice: 15.0,
    outputPrice: 60.0,
    contextWindow: 200000,
    maxOutput: 100000,
    reasoning: true,
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128000,
    maxOutput: 65536,
    reasoning: true,
  },
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

  // Anthropic
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    inputPrice: 1.0,
    outputPrice: 5.0,
    contextWindow: 200000,
    maxOutput: 8192,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    inputPrice: 3.0,
    outputPrice: 15.0,
    contextWindow: 200000,
    maxOutput: 64000,
    reasoning: true,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    inputPrice: 15.0,
    outputPrice: 75.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    inputPrice: 15.0,
    outputPrice: 75.0,
    contextWindow: 200000,
    maxOutput: 32000,
    reasoning: true,
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
  {
    id: "xai/grok-3-fast",
    name: "Grok 3 Fast",
    inputPrice: 5.0,
    outputPrice: 25.0,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true,
  },
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
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
 * All BlockRun models in OpenClaw format.
 */
export const OPENCLAW_MODELS: ModelDefinitionConfig[] = BLOCKRUN_MODELS.map(toOpenClawModel);

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
