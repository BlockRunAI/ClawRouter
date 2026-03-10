interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
}

const PRICING: Record<string, ModelPricing> = {
  'google/gemini-3.1-flash-lite-preview': { inputPerM: 0.075, outputPerM: 0.30 },
  'anthropic/claude-haiku-4.5': { inputPerM: 0.80, outputPerM: 4.00 },
  'anthropic/claude-sonnet-4.6': { inputPerM: 3.00, outputPerM: 15.00 },
  'anthropic/claude-opus-4.6': { inputPerM: 15.00, outputPerM: 75.00 },
  'amazon/nova-2-lite-v1': { inputPerM: 0.06, outputPerM: 0.24 },
  'openai/gpt-5-nano': { inputPerM: 0.10, outputPerM: 0.40 },
  'openai/gpt-oss-120b': { inputPerM: 0.00, outputPerM: 0.00 },
  'minimax/minimax-m2.5': { inputPerM: 0.50, outputPerM: 1.50 },
  'xai/grok-4.1-fast': { inputPerM: 2.00, outputPerM: 10.00 }
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  
  return (inputTokens / 1_000_000) * pricing.inputPerM + 
         (outputTokens / 1_000_000) * pricing.outputPerM;
}
