/**
 * Novita AI Provider Plugin for OpenClaw
 *
 * Registers Novita AI as an LLM provider with direct API access.
 * Uses OpenAI-compatible endpoint at https://api.novita.ai/openai
 *
 * Users provide their own NOVITA_API_KEY for authentication.
 */

import type { ProviderPlugin, ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

/**
 * Novita AI model definitions.
 * Model IDs and pricing from Novita AI catalog (CLAUDE.md).
 */
type NovitaModel = {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  agentic?: boolean;
  toolCalling?: boolean;
};

const NOVITA_MODEL_DEFS: NovitaModel[] = [
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (Novita)",
    inputPrice: 0.6,
    outputPrice: 3.0,
    contextWindow: 262144,
    maxOutput: 262144,
    reasoning: true,
    vision: true,
    agentic: true,
    toolCalling: true,
  },
  {
    id: "zai-org/glm-5",
    name: "GLM-5 (Novita)",
    inputPrice: 1.0,
    outputPrice: 3.2,
    contextWindow: 202800,
    maxOutput: 131072,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5 (Novita)",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 131100,
    reasoning: true,
    toolCalling: true,
  },
];

/**
 * Convert Novita model definitions to OpenClaw ModelDefinitionConfig format.
 */
function toOpenClawModel(m: NovitaModel): ModelDefinitionConfig {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions" as const,
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
 * All Novita models in OpenClaw format.
 */
export const NOVITA_MODELS: ModelDefinitionConfig[] = NOVITA_MODEL_DEFS.map(toOpenClawModel);

/**
 * Build a ModelProviderConfig for Novita AI.
 */
export function buildNovitaProviderModels(apiKey: string): ModelProviderConfig {
  return {
    baseUrl: "https://api.novita.ai/openai/v1",
    api: "openai-completions" as const,
    apiKey,
    models: NOVITA_MODELS,
  };
}

/**
 * Novita AI provider plugin definition.
 */
export const novitaProvider: ProviderPlugin = {
  id: "novita",
  label: "Novita AI",
  docsPath: "https://novita.ai/docs",
  aliases: ["novita"],
  envVars: ["NOVITA_API_KEY"],

  get models() {
    return {
      baseUrl: "https://api.novita.ai/openai/v1",
      api: "openai-completions" as const,
      models: NOVITA_MODELS,
    };
  },

  auth: [
    {
      id: "api_key",
      label: "API Key",
      hint: "Get your API key from https://novita.ai/dashboard",
      kind: "api_key",
      run: async (ctx) => {
        const apiKey = await ctx.prompter.text({
          message: "Enter your Novita API key:",
          validate: (value) => {
            if (!value || value.trim().length === 0) {
              return "API key is required";
            }
            return undefined;
          },
        });

        if (typeof apiKey !== "string") {
          return { profiles: [] };
        }

        return {
          profiles: [
            {
              profileId: "default",
              credential: {
                type: "api_key",
                apiKey: apiKey.trim(),
              },
            },
          ],
          defaultModel: "moonshotai/kimi-k2.5",
          notes: ["Novita AI models use pay-per-token pricing via your Novita account."],
        };
      },
    },
  ],

  formatApiKey: (cred) => {
    return cred.apiKey ?? "";
  },
};
